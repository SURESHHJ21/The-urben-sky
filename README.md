# THE URBAN SKY — Restaurant & Resto-Bar

An elevated dining and resto-bar web application built for **THE URBAN SKY** in Davanagere. Features table reservations, live table availability, digital menu with dietary filtering, guest booking lookup and cancellation, an administrative dashboard, and Google Gemini AI concierge.

---

## 🌟 Key Features

- **Table Reservation System**: Live table selection, guest party size, time slots, special requests, and real-time confirmation.
- **Booking Management**: Guest self-service booking lookup, status check, and cancellation.
- **Admin Dashboard**: Manage reservations, add/edit/delete menu items, adjust floor tables, and inspect inquiries.
  - Access at: `/admin`
  - Quick sign-in available for verified administrators.
- **Interactive Digital Menu**: Starters, main courses, cocktails, desserts, chef specials, dietary filters (Vegetarian, Non-Veg, Vegan, Gluten-Free).
- **Google Gemini Concierge**: AI assistant recommending dishes, answering wine pairings, dietary inquiries, and restaurant questions.
- **Responsive & Modern UI**: Built with React 19, TypeScript, Lucide icons, and Tailwind CSS.
- **Firebase & Supabase Sync**: Cloud database persistence and Google authentication.

---

## 🚀 Tech Stack

- **Frontend**: React 19, TypeScript, Vite, Tailwind CSS, Lucide React
- **Backend**: Express.js, TypeScript (`tsx` / Node.js)
- **Database & Auth**: Cloud Firestore, Supabase, Local JSON DB fallback
- **AI**: Google Gemini API (@google/genai)

---

## 📦 Getting Started

### 1. Clone or Extract the Repository
```bash
git clone https://github.com/<your-username>/the-urban-sky.git
cd the-urban-sky
```

### 2. Install Dependencies
```bash
npm install
```

### 3. Environment Variables (Optional)
Copy `.env.example` to `.env`:
```bash
cp .env.example .env
```
Fill in your API keys if you wish to use custom services:
- `GEMINI_API_KEY`: For the AI concierge
- `VITE_FIREBASE_*`: For custom Firebase project integration
- `SUPABASE_URL` & `SUPABASE_ANON_KEY`: For Supabase integration

### 4. Run Development Server
```bash
npm run dev
```
Open [http://localhost:3000](http://localhost:3000) in your browser.

### 5. Production Build
```bash
npm run build
npm start
```

---

## 📁 Project Structure

```text
├── server.ts                       # Backend Express API server
├── server/                         # Server handlers (db, gemini, supabase)
├── data/database.json              # Local fallback database
├── public/                         # Public static assets & sitemap
├── src/
│   ├── App.tsx                     # Main routing & application layout
│   ├── components/                 # Modals, Navbar, Footer, Chat Widget
│   ├── context/                    # Restaurant & Auth context providers
│   ├── pages/                      # Menu, Reservations, About, Contact, Admin
│   └── types.ts                    # TypeScript data definitions
└── firestore.rules                 # Cloud Firestore security rules
```

---

## 📄 License
MIT License. Created for **THE URBAN SKY - Restaurant & Resto-Bar**.
