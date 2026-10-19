const express = require('express');
const mongoose = require('mongoose');
const cookieParser = require('cookie-parser');
const rateLimit = require('express-rate-limit');
const xss = require('xss-clean');
require('dotenv').config();

const app = express();
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(cookieParser());
app.use(xss());

// --- MONGODB SERVERLESS CONNECTION & MODELS ---
let cachedDb = global.mongoose;
if (!cachedDb) cachedDb = global.mongoose = { conn: null, promise: null };

async function dbConnect() {
  if (cachedDb.conn) return cachedDb.conn;
  if (!process.env.MONGODB_URI) throw new Error("MONGODB_URI is required");
  if (!cachedDb.promise) {
    cachedDb.promise = mongoose.connect(process.env.MONGODB_URI, { 
      dbName: process.env.MONGODB_DB || 'dentalcare',
      serverSelectionTimeoutMS: 5000 
    }).then(m => m);
  }
  cachedDb.conn = await cachedDb.promise;
  return cachedDb.conn;
}

function getModels() {
  if (mongoose.models.Appointment) return mongoose.models;
  
  const AppointmentSchema = new mongoose.Schema({
    bookingReference: { type: String, unique: true },
    patientName: { type: String, required: true },
    patientEmail: { type: String, required: true },
    patientPhone: { type: String, required: true },
    serviceId: { type: mongoose.Schema.Types.ObjectId, ref: 'Service' },
    serviceSnapshot: String,
    dentistId: { type: mongoose.Schema.Types.ObjectId, ref: 'Dentist' },
    dentistSnapshot: String,
    appointmentDate: { type: String, required: true }, // YYYY-MM-DD
    appointmentStart: { type: String, required: true }, // HH:MM
    feeSnapshot: Number,
    status: { type: String, default: 'Pending', enum: ['Pending', 'Confirmed', 'Completed', 'Cancelled'] },
    patientReason: String,
    internalNote: String
  }, { timestamps: true });

  // Atomic Reservation: Prevents overlapping non-cancelled appointments for the same dentist
  AppointmentSchema.index(
    { dentistId: 1, appointmentDate: 1, appointmentStart: 1 },
    { unique: true, partialFilterExpression: { status: { $ne: 'Cancelled' } } }
  );

  const ServiceSchema = new mongoose.Schema({
    name: String, description: String, fee: Number, durationMinutes: Number, icon: String, active: { type: Boolean, default: true }
  }, { timestamps: true });

  const DentistSchema = new mongoose.Schema({
    displayName: String, specialty: String, biography: String, imageUrl: String, active: { type: Boolean, default: true }
  }, { timestamps: true });

  mongoose.model('Appointment', AppointmentSchema);
  mongoose.model('Service', ServiceSchema);
  mongoose.model('Dentist', DentistSchema);
  return mongoose.models;
}

// --- DATABASE SEEDING ---
async function seedDatabase() {
  const { Service, Dentist } = getModels();
  const sCount = await Service.countDocuments();
  if (sCount === 0) {
    await Service.insertMany([
      { name: "General Consultation", description: "Comprehensive dental check-up and preventive care plan.", fee: 800, durationMinutes: 30, icon: "stethoscope" },
      { name: "Teeth Whitening", description: "Professional whitening for a brighter, confident smile.", fee: 5000, durationMinutes: 60, icon: "sparkles" },
      { name: "Professional Cleaning", description: "Deep scaling and polishing to maintain gum health.", fee: 1500, durationMinutes: 45, icon: "droplets" }
    ]);
  }
  const dCount = await Dentist.countDocuments();
  if (dCount === 0) {
    await Dentist.insertMany([
      { displayName: "Dr. Aarya Sharma", specialty: "General & Preventive Dentistry", biography: "Friendly care focusing on long-term oral health.", imageUrl: "https://images.unsplash.com/photo-1559839734-2b71ea197ec2?auto=format&fit=crop&w=400&q=80" },
      { displayName: "Dr. Nisha Adhikari", specialty: "Cosmetic Dentistry", biography: "Specializes in smile transformations and whitening.", imageUrl: "https://images.unsplash.com/photo-1594824436998-dd40e4f69d1b?auto=format&fit=crop&w=400&q=80" },
      { displayName: "Dr. Rohan Thapa", specialty: "Orthodontics", biography: "Expert in braces and aligners for all ages.", imageUrl: "https://images.unsplash.com/photo-1622253692010-333f2da6031d?auto=format&fit=crop&w=400&q=80" }
    ]);
  }
}

// --- MIDDLEWARE & SECURITY ---
const apiLimiter = rateLimit({ windowMs: 15 * 60 * 1000, max: 100, message: "Too many requests." });
app.use('/api/', apiLimiter);

app.use(async (req, res, next) => {
  try {
    await dbConnect();
    await seedDatabase();
    next();
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Database connection failed" });
  }
});

// --- PUBLIC REST API ---
app.get('/api/public/data', async (req, res) => {
  const { Service, Dentist } = getModels();
  const services = await Service.find({ active: true }).lean();
  const dentists = await Dentist.find({ active: true }).lean();
  res.json({ services, dentists });
});

app.get('/api/public/availability', async (req, res) => {
  const { date, dentistId } = req.query;
  if (!date || !dentistId) return res.status(400).json({ error: "Missing parameters" });
  
  const dObj = new Date(date);
  const day = dObj.getDay(); // 0 = Sun, 6 = Sat
  let slots = [];
  
  if (day === 6) {
    // Saturday: 10 AM - 3 PM
    slots = ["10:00", "10:30", "11:00", "11:30", "12:00", "12:30", "13:00", "13:30", "14:00", "14:30"];
  } else {
    // Sun-Fri: 9 AM - 6 PM
    slots = ["09:00", "09:30", "10:00", "10:30", "11:00", "11:30", "12:00", "12:30", "13:00", "13:30", "14:00", "14:30", "15:00", "15:30", "16:00", "16:30", "17:00", "17:30"];
  }

  // Filter out past slots if today (assuming local time via simple comparison)
  const todayDateStr = new Date().toISOString().split('T')[0];
  if (date < todayDateStr) slots = [];

  const { Appointment } = getModels();
  const bookings = await Appointment.find({ dentistId, appointmentDate: date, status: { $ne: 'Cancelled' } }).lean();
  const bookedTimes = bookings.map(b => b.appointmentStart);
  const available = slots.filter(s => !bookedTimes.includes(s));
  
  res.json({ available });
});

app.post('/api/public/book', async (req, res) => {
  const { name, email, phone, serviceId, dentistId, date, time, reason } = req.body;
  if (!name || !email || !phone || !serviceId || !dentistId || !date || !time) return res.status(400).json({ error: "All required fields must be filled." });
  
  try {
    const { Appointment, Service, Dentist } = getModels();
    const service = await Service.findById(serviceId);
    const dentist = await Dentist.findById(dentistId);
    if (!service || !dentist) return res.status(400).json({ error: "Invalid selection." });

    const bookingReference = 'DC-' + Math.random().toString(36).substr(2, 6).toUpperCase();

    const appt = new Appointment({
      bookingReference, patientName: name, patientEmail: email, patientPhone: phone,
      serviceId, serviceSnapshot: service.name, feeSnapshot: service.fee,
      dentistId, dentistSnapshot: dentist.displayName,
      appointmentDate: date, appointmentStart: time, patientReason: reason, status: 'Pending'
    });

    await appt.save();
    res.json({ success: true, bookingReference, message: "Appointment request submitted! We will review and confirm shortly." });
  } catch (err) {
    if (err.code === 11000) return res.status(409).json({ error: "This exact time slot was just booked by someone else. Please select another time." });
    console.error(err);
    res.status(500).json({ error: "Failed to create booking." });
  }
});

// --- PUBLIC FRONTEND GENERATION ---
const HTML_TEMPLATE = `
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>DentalCare Smile Studio</title>
  <link href="https://fonts.googleapis.com/css2?family=Nunito:wght@400;600;800;900&display=swap" rel="stylesheet">
  <script src="https://unpkg.com/lucide@latest"></script>
  <style>
    :root {
      --bg: #F0F5FA;
      --surface: #FFFFFF;
      --primary: #5B8DEF;
      --primary-hover: #4A7CE0;
      --secondary: #FF8E8E;
      --text: #26324B;
      --text-muted: #6B7A99;
      --clay-shadow: 12px 12px 24px #D9E2EC, -12px -12px 24px #FFFFFF;
      --clay-inset: inset 6px 6px 12px #D9E2EC, inset -6px -6px 12px #FFFFFF;
      --btn-shadow: 6px 6px 12px #B3CBEF, -6px -6px 12px #FFFFFF;
      --radius-sm: 16px;
      --radius-md: 24px;
      --radius-lg: 32px;
      --radius-full: 999px;
    }
    * { margin: 0; padding: 0; box-sizing: border-box; font-family: 'Nunito', sans-serif; }
    body { background-color: var(--bg); color: var(--text); overflow-x: hidden; scroll-behavior: smooth; }
    .container { max-width: 1200px; margin: 0 auto; padding: 0 20px; }
    
    /* Typography */
    h1, h2, h3 { color: var(--text); font-weight: 900; }
    h1 { font-size: 3.5rem; line-height: 1.2; margin-bottom: 20px; }
    h2 { font-size: 2.5rem; margin-bottom: 40px; text-align: center; }
    p { color: var(--text-muted); line-height: 1.6; margin-bottom: 20px; }
    .badge-demo { background: var(--secondary); color: white; padding: 4px 12px; border-radius: 12px; font-size: 0.8rem; font-weight: bold; }
    
    /* Claymorphism Utilities */
    .clay-card { background: var(--surface); border-radius: var(--radius-md); box-shadow: var(--clay-shadow); padding: 30px; border: 2px solid rgba(255,255,255,0.8); transition: transform 0.3s; }
    .clay-card:hover { transform: translateY(-5px); }
    .clay-inset-box { background: var(--bg); border-radius: var(--radius-sm); box-shadow: var(--clay-inset); padding: 20px; }
    
    .clay-btn { display: inline-flex; align-items: center; gap: 8px; background: var(--primary); color: white; padding: 14px 28px; border-radius: var(--radius-full); font-size: 1.1rem; font-weight: 800; text-decoration: none; border: none; cursor: pointer; box-shadow: var(--btn-shadow); transition: all 0.2s; }
    .clay-btn:active { transform: scale(0.95); box-shadow: inset 4px 4px 8px rgba(0,0,0,0.1), inset -4px -4px 8px rgba(255,255,255,0.2); }
    .clay-btn.secondary { background: var(--surface); color: var(--primary); box-shadow: var(--clay-shadow); }
    
    /* Layouts */
    .grid-3 { display: grid; grid-template-columns: repeat(auto-fit, minmax(300px, 1fr)); gap: 30px; }
    .grid-2 { display: grid; grid-template-columns: repeat(auto-fit, minmax(400px, 1fr)); gap: 40px; }
    section { padding: 100px 0; }
    
    /* Navbar */
    nav { position: sticky; top: 0; z-index: 100; background: rgba(240,245,250,0.8); backdrop-filter: blur(10px); padding: 20px 0; box-shadow: 0 4px 20px rgba(0,0,0,0.05); }
    .nav-content { display: flex; justify-content: space-between; align-items: center; }
    .logo { display: flex; align-items: center; gap: 10px; font-weight: 900; font-size: 1.5rem; color: var(--primary); text-decoration: none; }
    .logo-icon { background: var(--surface); padding: 10px; border-radius: var(--radius-sm); box-shadow: var(--clay-shadow); }
    .nav-links { display: flex; gap: 20px; align-items: center; }
    .nav-links a { text-decoration: none; color: var(--text-muted); font-weight: 600; transition: color 0.2s; }
    .nav-links a:hover { color: var(--primary); }
    
    /* Hero */
    .hero { min-height: 80vh; display: flex; align-items: center; position: relative; }
    .hero-img { border-radius: var(--radius-lg); box-shadow: var(--clay-shadow); width: 100%; object-fit: cover; height: 500px; border: 4px solid white; }
    .floating-pill { position: absolute; background: white; padding: 15px 25px; border-radius: var(--radius-full); box-shadow: var(--clay-shadow); font-weight: bold; color: var(--primary); display: flex; align-items: center; gap: 10px; animation: float 3s ease-in-out infinite; }
    @keyframes float { 0%, 100% { transform: translateY(0); } 50% { transform: translateY(-15px); } }

    /* Service & Dentist Cards */
    .icon-circle { width: 60px; height: 60px; border-radius: 50%; background: var(--bg); display: flex; align-items: center; justify-content: center; box-shadow: var(--clay-inset); color: var(--primary); margin-bottom: 20px; }
    .dentist-img { width: 100px; height: 100px; border-radius: 50%; object-fit: cover; box-shadow: var(--clay-shadow); border: 3px solid white; margin: 0 auto 15px; display: block; }
    .price-tag { font-size: 1.2rem; font-weight: 900; color: var(--primary); }
    
    /* Booking Form */
    #booking { background: linear-gradient(135deg, #E9F1FA, #DCEEFF); }
    .form-group { margin-bottom: 20px; text-align: left; }
    .form-group label { display: block; font-weight: 800; margin-bottom: 8px; color: var(--text); }
    .form-control { width: 100%; padding: 15px 20px; border: none; border-radius: var(--radius-sm); background: var(--bg); box-shadow: var(--clay-inset); font-size: 1rem; color: var(--text); outline: none; transition: box-shadow 0.2s; }
    .form-control:focus { box-shadow: inset 8px 8px 16px #D9E2EC, inset -8px -8px 16px #FFFFFF; }
    .slots-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(80px, 1fr)); gap: 10px; margin-top: 10px; }
    .slot-btn { padding: 10px; border-radius: var(--radius-sm); border: none; background: var(--surface); box-shadow: var(--clay-shadow); cursor: pointer; font-weight: bold; transition: 0.2s; }
    .slot-btn:hover { color: var(--primary); }
    .slot-btn.selected { background: var(--primary); color: white; box-shadow: var(--clay-inset); }

    /* Footer */
    footer { background: var(--surface); padding: 50px 0; text-align: center; border-top: 2px solid white; }
    footer p { margin-bottom: 10px; }

    /* Responsive */
    @media (max-width: 768px) {
      .nav-links { display: none; }
      h1 { font-size: 2.5rem; }
      .grid-2 { grid-template-columns: 1fr; }
    }
  </style>
</head>
<body>

  <!-- Notice Banner -->
  <div style="background: var(--secondary); color: white; text-align: center; padding: 10px; font-size: 0.9rem; font-weight: bold;">
    Note: This is a demo booking system. Fictional contact information and illustrative prices are used.
  </div>

  <nav>
    <div class="container nav-content">
      <a href="#" class="logo">
        <div class="logo-icon"><i data-lucide="smile"></i></div>
        DentalCare
      </a>
      <div class="nav-links">
        <a href="#services">Services</a>
        <a href="#dentists">Our Dentists</a>
        <a href="#about">About</a>
        <a href="#booking" class="clay-btn" style="padding: 10px 20px; font-size: 1rem;">Book Now</a>
      </div>
    </div>
  </nav>

  <section class="hero container grid-2">
    <div>
      <h1>Your Healthiest Smile Starts Here.</h1>
      <p style="font-size: 1.2rem; margin-bottom: 30px;">Friendly dental care, modern treatments, and a comfortable experience designed around you in the heart of Kathmandu.</p>
      <div style="display: flex; gap: 15px; flex-wrap: wrap;">
        <a href="#booking" class="clay-btn">Book Your Appointment <i data-lucide="arrow-right"></i></a>
        <a href="#services" class="clay-btn secondary">Explore Services</a>
      </div>
      <div style="margin-top: 40px; display: flex; gap: 30px; align-items: center;">
        <div>
          <h3 style="font-size: 2rem; color: var(--primary);">4.9/5</h3>
          <p style="font-size: 0.9rem;"><span class="badge-demo">DEMO STAT</span> Patient Rating</p>
        </div>
        <div>
          <h3 style="font-size: 2rem; color: var(--primary);">10k+</h3>
          <p style="font-size: 0.9rem;"><span class="badge-demo">DEMO STAT</span> Happy Smiles</p>
        </div>
      </div>
    </div>
    <div style="position: relative;">
      <img src="https://images.unsplash.com/photo-1606811841689-23dfddce3e95?auto=format&fit=crop&w=800&q=80" alt="Friendly Dentist" class="hero-img">
      <div class="floating-pill" style="top: 20px; right: -20px;"><i data-lucide="shield-check" color="var(--primary)"></i> Gentle Care</div>
      <div class="floating-pill" style="bottom: 40px; left: -20px; animation-delay: 1.5s;"><i data-lucide="sparkles" color="var(--primary)"></i> Modern Tech</div>
    </div>
  </section>

  <section id="services" class="container">
    <h2>Our Dental Services</h2>
    <div class="grid-3" id="servicesGrid">
      <p style="text-align: center;">Loading services...</p>
    </div>
  </section>

  <section id="why" style="background: var(--surface);">
    <div class="container">
      <h2>Why Choose Us?</h2>
      <div class="grid-3">
        <div class="clay-card">
          <div class="icon-circle"><i data-lucide="heart"></i></div>
          <h3>Friendly Experience</h3>
          <p>We prioritize your comfort with a gentle approach to eliminate dental anxiety.</p>
        </div>
        <div class="clay-card">
          <div class="icon-circle"><i data-lucide="cpu"></i></div>
          <h3>Modern Technology</h3>
          <p>Equipped with the latest tools for accurate diagnostics and painless treatments.</p>
        </div>
        <div class="clay-card">
          <div class="icon-circle"><i data-lucide="wallet"></i></div>
          <h3>Transparent Pricing</h3>
          <p>No hidden fees. Illustrative prices are provided upfront so you know what to expect.</p>
        </div>
      </div>
    </div>
  </section>

  <section id="dentists" class="container">
    <h2>Meet Our Dentists</h2>
    <p style="text-align: center; margin-bottom: 40px;">Experienced professionals dedicated to your oral health. <span class="badge-demo">FICTIONAL PROFILES</span></p>
    <div class="grid-3" id="dentistsGrid">
      <p style="text-align: center;">Loading dentists...</p>
    </div>
  </section>

  <section id="booking">
    <div class="container grid-2" style="align-items: flex-start;">
      <div>
        <h2>Book Your Visit</h2>
        <p>Schedule an appointment in minutes. All bookings are subject to final clinic confirmation. Please bring valid ID on your visit.</p>
        
        <div class="clay-card" style="margin-top: 30px;">
          <h3>Contact Info</h3><br>
          <p><strong><i data-lucide="map-pin"></i> Address:</strong><br> 123 Smile Avenue, Kathmandu, Nepal</p>
          <p><strong><i data-lucide="phone"></i> Phone:</strong><br> +977-9800000000</p>
          <p><strong><i data-lucide="mail"></i> Email:</strong><br> hello@dentalcare-demo.example</p>
          <p><strong><i data-lucide="clock"></i> Hours:</strong><br> Sun-Fri: 9AM - 6PM <br> Sat: 10AM - 3PM</p>
        </div>
      </div>

      <div class="clay-card">
        <form id="bookingForm" onsubmit="submitBooking(event)">
          <div id="formMsg"></div>
          
          <div class="grid-2" style="gap: 20px;">
            <div class="form-group">
              <label>Full Name</label>
              <input type="text" id="fName" class="form-control" required>
            </div>
            <div class="form-group">
              <label>Phone Number</label>
              <input type="tel" id="fPhone" class="form-control" required>
            </div>
          </div>
          
          <div class="form-group">
            <label>Email Address</label>
            <input type="email" id="fEmail" class="form-control" required>
          </div>

          <div class="form-group">
            <label>Select Service</label>
            <select id="fService" class="form-control" required onchange="updateTotal()"></select>
          </div>

          <div class="form-group">
            <label>Select Dentist</label>
            <select id="fDentist" class="form-control" required onchange="fetchSlots()"></select>
          </div>

          <div class="form-group">
            <label>Appointment Date</label>
            <input type="date" id="fDate" class="form-control" required onchange="fetchSlots()">
          </div>

          <div class="form-group">
            <label>Available Times</label>
            <div class="clay-inset-box">
              <div id="slotsGrid" class="slots-grid">
                <small>Select a dentist and date to see slots.</s
