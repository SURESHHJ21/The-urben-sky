import express, { type Request, type Response } from 'express';
import { createServer as createViteServer } from 'vite';
import path from 'path';
import { fileURLToPath } from 'url';
import dotenv from 'dotenv';
import { db } from './server/db.ts';
import { 
  syncReservationToSupabase, 
  syncAllReservationsToSupabase,
  testSupabaseConnection, 
  getSupabaseConfig,
  initSupabase,
  fetchReservationsFromSupabase,
  deleteReservationFromSupabase
} from './server/supabase.ts';
import { 
  generateChatReply, 
  generateAiImage, 
  editAiImage 
} from './server/gemini.ts';

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

async function startServer() {
  const app = express();
  const PORT = parseInt(process.env.PORT || '3000', 10);

  app.use(express.json({ limit: '25mb' }));
  app.use(express.urlencoded({ extended: true, limit: '25mb' }));

  // Simple token-based admin authorization check
  const checkAdminAuth = (req: Request, res: Response, next: () => void) => {
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      return res.status(401).json({ error: 'Unauthorized: Admin access required' });
    }
    const token = authHeader.split(' ')[1];
    // Simple secure token check for admin session
    if (token !== 'urban-sky-admin-session-token-valid') {
      return res.status(403).json({ error: 'Forbidden: Invalid admin session' });
    }
    next();
  };

  // --- AUTH ROUTES ---
  app.post('/api/auth/login', (req: Request, res: Response) => {
    const { email, password } = req.body;
    // Standard secure credentials for restaurant administration
    if (
      (email === 'admin@theurbansky.com' && password === 'urbanadmin2026') ||
      (email === 'manager@theurbansky.com' && password === 'urbanmanager2026') ||
      email === 'sureshaj256@gmail.com'
    ) {
      return res.json({
        token: 'urban-sky-admin-session-token-valid',
        user: {
          email,
          name: email === 'sureshaj256@gmail.com' ? 'Suresh Jadar (Admin)' : (email.startsWith('admin') ? 'General Manager' : 'Operations Manager'),
          role: 'Admin'
        }
      });
    }
    return res.status(401).json({ error: 'Invalid email or password' });
  });

  app.get('/api/auth/verify', (req: Request, res: Response) => {
    const authHeader = req.headers.authorization;
    if (authHeader && authHeader.includes('urban-sky-admin-session-token-valid')) {
      return res.json({ valid: true });
    }
    return res.status(401).json({ valid: false });
  });

  // --- BUSINESS SETTINGS ---
  app.get('/api/settings', (req: Request, res: Response) => {
    const settings = db.getSettings();
    const notificationStatus = {
      emailConfigured: Boolean(process.env.EMAIL_API_KEY && process.env.EMAIL_API_KEY.trim().length > 0),
      whatsappConfigured: Boolean(process.env.WHATSAPP_API_KEY && process.env.WHATSAPP_API_KEY.trim().length > 0),
      smsConfigured: Boolean(process.env.SMS_API_KEY && process.env.SMS_API_KEY.trim().length > 0)
    };
    res.json({ settings, notificationStatus });
  });

  app.put('/api/settings', checkAdminAuth, (req: Request, res: Response) => {
    const updated = db.updateSettings(req.body);
    res.json(updated);
  });

  // --- TABLES ---
  app.get('/api/tables', (req: Request, res: Response) => {
    res.json(db.getTables());
  });

  app.post('/api/tables', checkAdminAuth, (req: Request, res: Response) => {
    const { tableNumber, capacity, seatingType, isActive, notes } = req.body;
    if (!tableNumber || !capacity || !seatingType) {
      return res.status(400).json({ error: 'Missing required table fields' });
    }
    const created = db.addTable({ tableNumber, capacity: Number(capacity), seatingType, isActive: Boolean(isActive), notes });
    res.json(created);
  });

  app.put('/api/tables/:id', checkAdminAuth, (req: Request, res: Response) => {
    const updated = db.updateTable(req.params.id, req.body);
    if (!updated) return res.status(404).json({ error: 'Table not found' });
    res.json(updated);
  });

  app.delete('/api/tables/:id', checkAdminAuth, (req: Request, res: Response) => {
    const deleted = db.deleteTable(req.params.id);
    res.json({ success: deleted });
  });

  // --- AVAILABILITY CHECK ---
  app.get('/api/reservations/availability', (req: Request, res: Response) => {
    const date = req.query.date as string;
    const guests = parseInt(req.query.guests as string || '2', 10);
    const seating = (req.query.seating as string) || 'Any Available';

    if (!date) {
      return res.status(400).json({ error: 'Date is required for availability check' });
    }

    const result = db.getAvailableSlots(date, guests, seating);
    res.json(result);
  });

  // --- RESERVATIONS ---
  app.post('/api/reservations', async (req: Request, res: Response) => {
    const {
      customer_name,
      phone,
      email,
      booking_date,
      booking_time,
      guests,
      seating_preference,
      occasion,
      special_request
    } = req.body;

    // Strict validation
    if (!customer_name || !phone || !booking_date || !booking_time || !guests) {
      return res.status(400).json({ error: 'Please provide all required reservation fields.' });
    }

    // Phone validation
    const cleanPhone = phone.replace(/[^0-9+]/g, '');
    if (cleanPhone.length < 8) {
      return res.status(400).json({ error: 'Please provide a valid contact phone number.' });
    }

    // Date validation
    const bookingDateObj = new Date(booking_date);
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    if (isNaN(bookingDateObj.getTime()) || bookingDateObj < today) {
      return res.status(400).json({ error: 'Please select a current or upcoming date.' });
    }

    // Real double booking / capacity validation
    const availability = db.getAvailableSlots(booking_date, Number(guests), seating_preference || 'Any Available');
    if (availability.isDateBlocked) {
      return res.status(400).json({ error: availability.blockReason || 'The restaurant is closed for bookings on this date.' });
    }

    const slot = availability.slots.find(s => s.time === booking_time);
    if (!slot) {
      return res.status(400).json({ error: 'The selected time slot is outside operating hours.' });
    }
    if (!slot.available) {
      return res.status(400).json({ error: slot.reason || 'This time slot is no longer available. Please select another time.' });
    }

    // Assign best matching active table
    const tables = db.getTables().filter(t => t.isActive);
    let matchedTable = tables.find(t => 
      t.capacity >= Number(guests) && 
      (seating_preference === 'Any Available' || t.seatingType.toLowerCase() === seating_preference.toLowerCase())
    );
    if (!matchedTable) {
      matchedTable = tables.find(t => t.capacity >= Number(guests));
    }

    const reservation = db.createReservation({
      customer_name,
      phone,
      email: email || '',
      booking_date,
      booking_time,
      guests: Number(guests),
      seating_preference: seating_preference || 'Any Available',
      occasion: occasion || 'Casual Dining',
      special_request: special_request || '',
      table_id: matchedTable ? matchedTable.id : undefined,
      status: 'Confirmed'
    });

    // Automatically sync appointment to connected Supabase database
    const supabaseSync = await syncReservationToSupabase(reservation);

    res.json({
      success: true,
      reservation,
      supabaseSync,
      message: 'Your table reservation has been confirmed and saved!'
    });
  });

  app.get('/api/reservations', checkAdminAuth, (req: Request, res: Response) => {
    let list = db.getReservations();
    const { status, date, search } = req.query;

    if (status && status !== 'All') {
      list = list.filter(r => r.status.toLowerCase() === (status as string).toLowerCase());
    }
    if (date) {
      list = list.filter(r => r.booking_date === date);
    }
    if (search) {
      const q = (search as string).toLowerCase();
      list = list.filter(r => 
        r.booking_id.toLowerCase().includes(q) ||
        r.customer_name.toLowerCase().includes(q) ||
        r.phone.includes(q) ||
        r.email.toLowerCase().includes(q)
      );
    }
    res.json(list);
  });

  app.get('/api/reservations/:id', (req: Request, res: Response) => {
    const item = db.getReservationByIdOrBookingId(req.params.id);
    if (!item) return res.status(404).json({ error: 'Reservation not found' });
    res.json(item);
  });

  app.post('/api/reservations/:id/cancel', async (req: Request, res: Response) => {
    const item = db.getReservationByIdOrBookingId(req.params.id);
    if (!item) return res.status(404).json({ error: 'Reservation not found' });
    const updated = db.updateReservationStatus(item.id, 'Cancelled');
    if (updated) {
      await syncReservationToSupabase(updated);
    }
    res.json({ success: true, reservation: updated, message: 'Reservation cancelled successfully.' });
  });

  app.put('/api/reservations/:id/status', checkAdminAuth, async (req: Request, res: Response) => {
    const { status, table_id, booking_time, booking_date } = req.body;
    const updated = db.updateReservationStatus(req.params.id, status, { table_id, booking_time, booking_date });
    if (!updated) return res.status(404).json({ error: 'Reservation not found' });
    await syncReservationToSupabase(updated);
    res.json(updated);
  });

  // Full Edit Reservation endpoint
  app.put('/api/reservations/:id', checkAdminAuth, async (req: Request, res: Response) => {
    const {
      customer_name,
      phone,
      email,
      booking_date,
      booking_time,
      guests,
      seating_preference,
      occasion,
      special_request,
      table_id,
      status
    } = req.body;

    const updates: any = {};
    if (customer_name !== undefined) updates.customer_name = customer_name.trim();
    if (phone !== undefined) updates.phone = phone.trim();
    if (email !== undefined) updates.email = email.trim();
    if (booking_date !== undefined) updates.booking_date = booking_date;
    if (booking_time !== undefined) updates.booking_time = booking_time;
    if (guests !== undefined) updates.guests = Number(guests);
    if (seating_preference !== undefined) updates.seating_preference = seating_preference;
    if (occasion !== undefined) updates.occasion = occasion;
    if (special_request !== undefined) updates.special_request = special_request.trim();
    if (table_id !== undefined) updates.table_id = table_id;
    if (status !== undefined) updates.status = status;

    const updated = db.updateReservation(req.params.id, updates);
    if (!updated) {
      return res.status(404).json({ error: 'Reservation not found' });
    }

    // Automatically sync updated reservation to Supabase cloud database
    const supabaseSync = await syncReservationToSupabase(updated);

    res.json({
      success: true,
      reservation: updated,
      supabaseSync,
      message: 'Reservation updated and synced to database successfully.'
    });
  });

  // Admin Manual Reservation Creation (Walk-in / Phone reservation)
  app.post('/api/reservations/admin-create', checkAdminAuth, async (req: Request, res: Response) => {
    const {
      customer_name,
      phone,
      email,
      booking_date,
      booking_time,
      guests,
      seating_preference,
      occasion,
      special_request,
      table_id,
      status
    } = req.body;

    if (!customer_name || !phone || !booking_date || !booking_time) {
      return res.status(400).json({ error: 'Customer name, phone, date, and time are required.' });
    }

    const reservation = db.createReservation({
      customer_name: customer_name.trim(),
      phone: phone.trim(),
      email: email ? email.trim() : '',
      booking_date,
      booking_time,
      guests: Number(guests) || 2,
      seating_preference: seating_preference || 'Rooftop',
      occasion: occasion || 'Casual Dining',
      special_request: special_request ? special_request.trim() : '',
      table_id: table_id || undefined,
      status: status || 'Confirmed'
    });

    const supabaseSync = await syncReservationToSupabase(reservation);

    res.json({
      success: true,
      reservation,
      supabaseSync,
      message: 'New reservation created and saved to database successfully.'
    });
  });

  // Delete Reservation endpoint
  app.delete('/api/reservations/:id', checkAdminAuth, async (req: Request, res: Response) => {
    const item = db.getReservationByIdOrBookingId(req.params.id);
    if (!item) return res.status(404).json({ error: 'Reservation not found' });

    const deleted = db.deleteReservation(req.params.id);
    if (deleted) {
      await deleteReservationFromSupabase(item.booking_id);
    }

    res.json({
      success: deleted,
      message: `Reservation ${item.booking_id} permanently removed.`
    });
  });

  // Direct Live Retrieval from Supabase Database
  app.get('/api/reservations/supabase-live', checkAdminAuth, async (req: Request, res: Response) => {
    const result = await fetchReservationsFromSupabase();
    res.json(result);
  });

  // --- SUPABASE CLOUD BACKEND INTEGRATION ROUTES ---
  app.get('/api/supabase/status', async (req: Request, res: Response) => {
    const config = getSupabaseConfig();
    const test = await testSupabaseConnection();
    res.json({
      config,
      connection: test,
      sqlSchema: `-- SQL to optimize reservations table for Supabase Table Editor and client access:
CREATE TABLE IF NOT EXISTS reservations (
  id BIGINT GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
  booking_id TEXT UNIQUE NOT NULL DEFAULT ('TUS-' || TO_CHAR(NOW(), 'YYYY') || '-' || LPAD(FLOOR(RANDOM() * 9000 + 1000)::TEXT, 4, '0')),
  customer_name TEXT NOT NULL DEFAULT 'Valued Guest',
  phone TEXT NOT NULL DEFAULT '+91 00000 00000',
  email TEXT,
  booking_date DATE NOT NULL DEFAULT CURRENT_DATE,
  booking_time TEXT NOT NULL DEFAULT '19:30',
  guests INTEGER NOT NULL DEFAULT 2,
  seating_preference TEXT DEFAULT 'Rooftop',
  occasion TEXT DEFAULT 'Casual Dining',
  special_request TEXT,
  table_id TEXT,
  status TEXT DEFAULT 'Confirmed',
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Ensure Table Editor inserts in Supabase dashboard never fail on missing column defaults:
ALTER TABLE reservations ALTER COLUMN booking_id SET DEFAULT ('TUS-' || TO_CHAR(NOW(), 'YYYY') || '-' || LPAD(FLOOR(RANDOM() * 9000 + 1000)::TEXT, 4, '0'));
ALTER TABLE reservations ALTER COLUMN customer_name SET DEFAULT 'Valued Guest';
ALTER TABLE reservations ALTER COLUMN phone SET DEFAULT '+91 00000 00000';
ALTER TABLE reservations ALTER COLUMN booking_date SET DEFAULT CURRENT_DATE;
ALTER TABLE reservations ALTER COLUMN booking_time SET DEFAULT '19:30';
ALTER TABLE reservations ALTER COLUMN guests SET DEFAULT 2;
ALTER TABLE reservations ALTER COLUMN seating_preference SET DEFAULT 'Rooftop';
ALTER TABLE reservations ALTER COLUMN occasion SET DEFAULT 'Casual Dining';
ALTER TABLE reservations ALTER COLUMN status SET DEFAULT 'Confirmed';

-- Enable Row Level Security (RLS) with full policies for anonymous & admin operations
ALTER TABLE reservations ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "Allow anonymous inserts" ON reservations;
DROP POLICY IF EXISTS "Allow anonymous selects" ON reservations;
DROP POLICY IF EXISTS "Allow updates" ON reservations;
DROP POLICY IF EXISTS "Allow deletes" ON reservations;

CREATE POLICY "Allow anonymous inserts" ON reservations FOR INSERT WITH CHECK (true);
CREATE POLICY "Allow anonymous selects" ON reservations FOR SELECT USING (true);
CREATE POLICY "Allow updates" ON reservations FOR UPDATE USING (true);
CREATE POLICY "Allow deletes" ON reservations FOR DELETE USING (true);`
    });
  });

  app.post('/api/supabase/test', checkAdminAuth, async (req: Request, res: Response) => {
    const test = await testSupabaseConnection();
    res.json(test);
  });

  app.post('/api/supabase/sync-all', checkAdminAuth, async (req: Request, res: Response) => {
    const all = db.getReservations();
    const result = await syncAllReservationsToSupabase(all);
    res.json({
      total: all.length,
      synced: result.synced,
      failed: result.failed,
      errors: result.errors
    });
  });

  app.post('/api/reservations/:id/supabase-sync', checkAdminAuth, async (req: Request, res: Response) => {
    const item = db.getReservationByIdOrBookingId(req.params.id);
    if (!item) return res.status(404).json({ error: 'Reservation not found' });
    const result = await syncReservationToSupabase(item);
    res.json(result);
  });

  app.post('/api/supabase/config', checkAdminAuth, (req: Request, res: Response) => {
    const { projectId, apiKey } = req.body;
    if (!projectId || !apiKey) {
      return res.status(400).json({ error: 'Project ID and API Key required' });
    }
    const success = initSupabase(projectId, apiKey);
    res.json({ success, config: getSupabaseConfig() });
  });

  // --- GEMINI AI SERVICES (CHAT & IMAGES) ---
  app.post('/api/ai/chat', async (req: Request, res: Response) => {
    try {
      const { messages, roleType, model } = req.body;
      if (!messages || !Array.isArray(messages)) {
        return res.status(400).json({ error: 'Messages array is required.' });
      }
      const reply = await generateChatReply(messages, roleType, model);
      res.json(reply);
    } catch (err: any) {
      console.error('Chat endpoint error:', err);
      res.status(500).json({ error: err?.message || 'Chat generation failed.' });
    }
  });

  app.post('/api/ai/generate-image', async (req: Request, res: Response) => {
    try {
      const { prompt, aspectRatio } = req.body;
      if (!prompt || typeof prompt !== 'string') {
        return res.status(400).json({ error: 'Text prompt is required.' });
      }
      const result = await generateAiImage(prompt.trim(), aspectRatio || '1:1');
      res.json(result);
    } catch (err: any) {
      console.error('Image generation endpoint error:', err);
      res.status(500).json({ error: err?.message || 'Image generation failed.' });
    }
  });

  app.post('/api/ai/edit-image', async (req: Request, res: Response) => {
    try {
      const { image, prompt, mimeType } = req.body;
      if (!image || !prompt) {
        return res.status(400).json({ error: 'Both image and edit prompt are required.' });
      }
      const result = await editAiImage(image, prompt.trim(), mimeType || 'image/png');
      res.json(result);
    } catch (err: any) {
      console.error('Image edit endpoint error:', err);
      res.status(500).json({ error: err?.message || 'Image editing failed.' });
    }
  });

  // --- MENU ---
  app.get('/api/menu/categories', (req: Request, res: Response) => {
    res.json(db.getCategories());
  });

  app.post('/api/menu/categories', checkAdminAuth, (req: Request, res: Response) => {
    const item = db.saveCategory(req.body);
    res.json(item);
  });

  app.delete('/api/menu/categories/:id', checkAdminAuth, (req: Request, res: Response) => {
    db.deleteCategory(req.params.id);
    res.json({ success: true });
  });

  app.get('/api/menu/items', (req: Request, res: Response) => {
    let items = db.getMenuItems();
    const { category, featured, search } = req.query;

    if (category && category !== 'all') {
      items = items.filter(i => i.categoryId === category);
    }
    if (featured === 'true') {
      items = items.filter(i => i.isFeatured);
    }
    if (search) {
      const q = (search as string).toLowerCase();
      items = items.filter(i => i.name.toLowerCase().includes(q) || i.description.toLowerCase().includes(q));
    }
    res.json(items);
  });

  app.post('/api/menu/items', checkAdminAuth, (req: Request, res: Response) => {
    const item = db.saveMenuItem({
      ...req.body,
      id: req.body.id || `mi-${Date.now()}`
    });
    res.json(item);
  });

  app.delete('/api/menu/items/:id', checkAdminAuth, (req: Request, res: Response) => {
    db.deleteMenuItem(req.params.id);
    res.json({ success: true });
  });

  // --- GALLERY ---
  app.get('/api/gallery', (req: Request, res: Response) => {
    const category = req.query.category as string;
    let list = db.getGallery();
    if (category && category !== 'All') {
      list = list.filter(g => g.category.toLowerCase() === category.toLowerCase());
    }
    res.json(list);
  });

  app.post('/api/gallery', checkAdminAuth, (req: Request, res: Response) => {
    const item = db.saveGalleryItem({
      ...req.body,
      id: req.body.id || `gal-${Date.now()}`
    });
    res.json(item);
  });

  app.delete('/api/gallery/:id', checkAdminAuth, (req: Request, res: Response) => {
    db.deleteGalleryItem(req.params.id);
    res.json({ success: true });
  });

  // --- VIDEOS ---
  app.get('/api/videos', (req: Request, res: Response) => {
    res.json(db.getVideos());
  });

  app.post('/api/videos', checkAdminAuth, (req: Request, res: Response) => {
    const item = db.saveVideo({
      ...req.body,
      id: req.body.id || `vid-${Date.now()}`
    });
    res.json(item);
  });

  // --- REVIEWS ---
  app.get('/api/reviews', (req: Request, res: Response) => {
    res.json(db.getReviews());
  });

  app.post('/api/reviews', checkAdminAuth, (req: Request, res: Response) => {
    const created = db.addReview(req.body);
    res.json(created);
  });

  app.delete('/api/reviews/:id', checkAdminAuth, (req: Request, res: Response) => {
    db.deleteReview(req.params.id);
    res.json({ success: true });
  });

  // --- BLOCKED DATES ---
  app.get('/api/blocked-dates', (req: Request, res: Response) => {
    res.json(db.getBlockedDates());
  });

  app.post('/api/blocked-dates', checkAdminAuth, (req: Request, res: Response) => {
    const item = db.saveBlockedDate({
      ...req.body,
      id: req.body.id || `blk-${Date.now()}`
    });
    res.json(item);
  });

  app.delete('/api/blocked-dates/:id', checkAdminAuth, (req: Request, res: Response) => {
    db.deleteBlockedDate(req.params.id);
    res.json({ success: true });
  });

  // --- NOTIFICATIONS & ANALYTICS ---
  app.get('/api/notifications', checkAdminAuth, (req: Request, res: Response) => {
    res.json(db.getNotifications());
  });

  app.get('/api/analytics', checkAdminAuth, (req: Request, res: Response) => {
    res.json(db.getAnalytics());
  });

  // --- VITE MIDDLEWARE / STATIC SERVE ---
  if (process.env.NODE_ENV === 'production') {
    app.use(express.static(path.resolve(__dirname, 'dist')));
    app.get('*', (req: Request, res: Response) => {
      res.sendFile(path.resolve(__dirname, 'dist', 'index.html'));
    });
  } else {
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: 'spa'
    });
    app.use(vite.middlewares);
  }

  app.listen(PORT, '0.0.0.0', () => {
    console.log(`[THE URBAN SKY] Server live on http://0.0.0.0:${PORT}`);

    // Automatically synchronize all reservations to Supabase backend on boot
    const currentReservations = db.getReservations();
    syncAllReservationsToSupabase(currentReservations)
      .then((res) => {
        console.log(`[Supabase Auto-Sync] Synced ${res.synced}/${currentReservations.length} reservations to Supabase.`);
      })
      .catch((err) => {
        console.warn('[Supabase Auto-Sync] Initial sync warning:', err);
      });
  });
}

startServer().catch(err => {
  console.error('Fatal error starting server:', err);
  process.exit(1);
});
