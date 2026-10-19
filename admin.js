const express = require('express');
const mongoose = require('mongoose');
const cookieParser = require('cookie-parser');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const xss = require('xss-clean');
require('dotenv').config();

const app = express();
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(cookieParser());
app.use(xss());

// --- MONGODB CACHING & MODELS ---
let cachedDb = global.mongoose;
if (!cachedDb) cachedDb = global.mongoose = { conn: null, promise: null };

async function dbConnect() {
  if (cachedDb.conn) return cachedDb.conn;
  if (!cachedDb.promise) {
    cachedDb.promise = mongoose.connect(process.env.MONGODB_URI, { dbName: process.env.MONGODB_DB || 'dentalcare' }).then(m => m);
  }
  cachedDb.conn = await cachedDb.promise;
  return cachedDb.conn;
}

function getModels() {
  if (mongoose.models.Appointment) return mongoose.models;
  const AppointmentSchema = new mongoose.Schema({
    bookingReference: String, patientName: String, patientEmail: String, patientPhone: String,
    serviceId: mongoose.Schema.Types.ObjectId, serviceSnapshot: String,
    dentistId: mongoose.Schema.Types.ObjectId, dentistSnapshot: String,
    appointmentDate: String, appointmentStart: String, feeSnapshot: Number,
    status: String, patientReason: String, internalNote: String
  }, { timestamps: true });
  mongoose.model('Appointment', AppointmentSchema);
  return mongoose.models;
}

// --- SECURE AUTHENTICATION MIDDLEWARE ---
const JWT_SECRET = process.env.SESSION_SECRET || 'dev_fallback_secret_strictly_for_local';
const ADMIN_EMAIL = process.env.ADMIN_EMAIL || 'admin@example.com';
const ADMIN_HASH = process.env.ADMIN_PASSWORD_HASH || bcrypt.hashSync('admin123', 10);

function requireAuth(req, res, next) {
  const token = req.cookies.admin_token;
  if (!token) return res.status(401).json({ error: "Unauthorized" });
  try {
    jwt.verify(token, JWT_SECRET);
    next();
  } catch (err) {
    res.status(401).json({ error: "Invalid Session" });
  }
}

// --- ADMIN API ENDPOINTS ---
app.post('/admin/api/login', async (req, res) => {
  const { email, password } = req.body;
  if (email !== ADMIN_EMAIL) return res.status(401).json({ error: "Invalid credentials" });
  const isMatch = await bcrypt.compare(password, ADMIN_HASH);
  if (!isMatch) return res.status(401).json({ error: "Invalid credentials" });
  
  const token = jwt.sign({ admin: true }, JWT_SECRET, { expiresIn: '8h' });
  res.cookie('admin_token', token, { httpOnly: true, secure: process.env.NODE_ENV === 'production', sameSite: 'strict', maxAge: 8*60*60*1000 });
  res.json({ success: true });
});

app.post('/admin/api/logout', (req, res) => {
  res.clearCookie('admin_token');
  res.json({ success: true });
});

app.get('/admin/api/stats', requireAuth, async (req, res) => {
  await dbConnect();
  const { Appointment } = getModels();
  const total = await Appointment.countDocuments();
  const pending = await Appointment.countDocuments({ status: 'Pending' });
  const confirmed = await Appointment.countDocuments({ status: 'Confirmed' });
  const completed = await Appointment.countDocuments({ status: 'Completed' });
  res.json({ total, pending, confirmed, completed });
});

app.get('/admin/api/appointments', requireAuth, async (req, res) => {
  await dbConnect();
  const { Appointment } = getModels();
  let query = {};
  if (req.query.status) query.status = req.query.status;
  const appts = await Appointment.find(query).sort({ appointmentDate: -1, appointmentStart: -1 }).limit(100).lean();
  res.json(appts);
});

app.put('/admin/api/appointments/:id/status', requireAuth, async (req, res) => {
  await dbConnect();
  const { Appointment } = getModels();
  const { status } = req.body;
  const validStatuses = ['Pending', 'Confirmed', 'Completed', 'Cancelled'];
  if (!validStatuses.includes(status)) return res.status(400).json({ error: "Invalid status" });
  
  await Appointment.findByIdAndUpdate(req.params.id, { status });
  res.json({ success: true });
});

// --- ADMIN HTML DASHBOARD ---
const ADMIN_HTML = `
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <title>DentalCare Admin</title>
  <link href="https://fonts.googleapis.com/css2?family=Nunito:wght@400;700;900&display=swap" rel="stylesheet">
  <style>
    :root { --bg: #E9F1FA; --surface: #FFFFFF; --primary: #5B8DEF; --text: #26324B; --shadow: 8px 8px 16px #D9E2EC, -8px -8px 16px #FFFFFF; --radius: 20px; }
    * { margin: 0; padding: 0; box-sizing: border-box; font-family: 'Nunito', sans-serif; }
    body { background: var(--bg); color: var(--text); display: flex; height: 100vh; overflow: hidden; }
    
    /* Login Screen */
    #loginScreen { position: fixed; inset: 0; background: var(--bg); display: flex; align-items: center; justify-content: center; z-index: 1000; }
    .login-box { background: var(--surface); padding: 40px; border-radius: var(--radius); box-shadow: var(--shadow); width: 100%; max-width: 400px; text-align: center; }
    .input { width: 100%; padding: 12px; margin: 10px 0; border: none; background: #F0F5FA; border-radius: 12px; box-shadow: inset 4px 4px 8px #D9E2EC, inset -4px -4px 8px #FFFFFF; outline: none; }
    .btn { background: var(--primary); color: white; border: none; padding: 12px 24px; border-radius: 12px; font-weight: bold; cursor: pointer; box-shadow: var(--shadow); width: 100%; margin-top: 10px; }
    
    /* Dashboard Layout */
    .sidebar { width: 250px; background: var(--surface); padding: 30px 20px; border-right: 2px solid white; box-shadow: 4px 0 10px rgba(0,0,0,0.02); }
    .main { flex: 1; padding: 40px; overflow-y: auto; }
    
    .stats-grid { display: grid; grid-template-columns: repeat(4, 1fr); gap: 20px; margin-bottom: 40px; }
    .stat-card { background: var(--surface); padding: 20px; border-radius: var(--radius); box-shadow: var(--shadow); text-align: center; }
    .stat-card h3 { font-size: 2.5rem; color: var(--primary); }
    
    table { width: 100%; border-collapse: collapse; background: var(--surface); border-radius: var(--radius); overflow: hidden; box-shadow: var(--shadow); margin-top: 20px; }
    th, td { padding: 15px; text-align: left; border-bottom: 1px solid #F0F5FA; }
    th { background: #F0F5FA; font-weight: 900; }
    
    .status-Pending { color: #f0ad4e; font-weight: bold; }
    .status-Confirmed { color: #5bc0de; font-weight: bold; }
    .status-Completed { color: #5cb85c; font-weight: bold; }
    .status-Cancelled { color: #d9534f; font-weight: bold; }

    .action-select { padding: 6px; border-radius: 8px; border: 1px solid #CCC; outline: none; }
  </style>
</head>
<body>

  <div id="loginScreen">
    <div class="login-box">
      <h2 style="margin-bottom: 20px; color: var(--primary);">Admin Secure Login</h2>
      <form id="loginForm" onsubmit="handleLogin(event)">
        <input type="email" id="lEmail" class="input" placeholder="Admin Email" required>
        <input type="password" id="lPass" class="input" placeholder="Password" required>
        <div id="lErr" style="color: red; margin: 10px 0; font-size: 0.9rem;"></div>
        <button type="submit" class="btn">Login to Dashboard</button>
      </form>
    </div>
  </div>

  <div class="sidebar">
    <h2 style="color: var(--primary); margin-bottom: 40px;">DentalCare<br>Admin</h2>
    <ul style="list-style: none; display: flex; flex-direction: column; gap: 15px;">
      <li><strong>Dashboard</strong></li>
      <li><a href="#" onclick="logout()" style="color: red; text-decoration: none;">Logout Securely</a></li>
    </ul>
  </div>

  <div class="main">
    <h1 style="margin-bottom: 30px;">Overview</h1>
    
    <div class="stats-grid">
      <div class="stat-card"><h3><span id="stTot">-</span></h3><p>Total Appointments</p></div>
      <div class="stat-card"><h3><span id="stPen">-</span></h3><p>Pending Review</p></div>
      <div class="stat-card"><h3><span id="stCon">-</span></h3><p>Confirmed</p></div>
      <div class="stat-card"><h3><span id="stCom">-</span></h3><p>Completed</p></div>
    </div>

    <div style="display: flex; justify-content: space-between; align-items: center;">
      <h2>Recent Appointments</h2>
      <select id="filterStatus" class="action-select" onchange="loadAppointments()">
        <option value="">All Statuses</option>
        <option value="Pending">Pending</option>
        <option value="Confirmed">Confirmed</option>
        <option value="Completed">Completed</option>
        <option value="Cancelled">Cancelled</option>
      </select>
    </div>

    <table>
      <thead>
        <tr>
          <th>Ref</th>
          <th>Patient</th>
          <th>Date & Time</th>
          <th>Dentist</th>
          <th>Service</th>
          <th>Status</th>
          <th>Action</th>
        </tr>
      </thead>
      <tbody id="apptsBody">
        <tr><td colspan="7" style="text-align: center;">Loading...</td></tr>
      </tbody>
    </table>
  </div>

  <script>
    // Simple check if cookie exists to hide login initially
    if(document.cookie.includes('admin_token')) {
      document.getElementById('loginScreen').style.display = 'none';
      loadDashboard();
    }

    async function handleLogin(e) {
      e.preventDefault();
      const res = await fetch('/admin/api/login', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: document.getElementById('lEmail').value, password: document.getElementById('lPass').value })
      });
      if(res.ok) {
        document.getElementById('loginScreen').style.display = 'none';
        loadDashboard();
      } else {
        document.getElementById('lErr').innerText = "Invalid credentials.";
      }
    }

    async function logout() {
      await fetch('/admin/api/logout', { method: 'POST' });
      window.location.reload();
    }

    async function loadDashboard() {
      loadStats();
      loadAppointments();
    }

    async function loadStats() {
      try {
        const res = await fetch('/admin/api/stats');
        if(res.status === 401) { logout(); return; }
        const data = await res.json();
        document.getElementById('stTot').innerText = data.total;
        document.getElementById('stPen').innerText = data.pending;
        document.getElementById('stCon').innerText = data.confirmed;
        document.getElementById('stCom').innerText = data.completed;
      } catch(e) {}
    }

    async function loadAppointments() {
      const filter = document.getElementById('filterStatus').value;
      const res = await fetch('/admin/api/appointments' + (filter ? '?status=' + filter : ''));
      if(res.status === 401) return;
      const data = await res.json();
      
      const tbody = document.getElementById('apptsBody');
      if(data.length === 0) { tbody.innerHTML = '<tr><td colspan="7" style="text-align:center;">No records found.</td></tr>'; return; }
      
      tbody.innerHTML = data.map(a => 
        '<tr>' +
          '<td><strong>' + a.bookingReference + '</strong></td>' +
          '<td>' + a.patientName + '<br><small>' + a.patientPhone + '</small></td>' +
          '<td>' + a.appointmentDate + ' <br> ' + a.appointmentStart + '</td>' +
          '<td>' + a.dentistSnapshot + '</td>' +
          '<td>' + a.serviceSnapshot + ' <br><small>NPR ' + a.feeSnapshot + '</small></td>' +
          '<td class="status-' + a.status + '">' + a.status + '</td>' +
          '<td>' +
            '<select class="action-select" onchange="updateStatus(\\'' + a._id + '\\', this.value)">' +
              '<option value="" disabled selected>Update</option>' +
              '<option value="Pending">Pending</option>' +
              '<option value="Confirmed">Confirm</option>' +
              '<option value="Completed">Complete</option>' +
              '<option value="Cancelled">Cancel</option>' +
            '</select>' +
          '</td>' +
        '</tr>'
      ).join('');
    }

    async function updateStatus(id, newStatus) {
      if(!newStatus || !confirm("Change status to " + newStatus + "?")) return;
      await fetch('/admin/api/appointments/' + id + '/status', {
        method: 'PUT', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ status: newStatus })
      });
      loadDashboard();
    }
  </script>
</body>
</html>
`;

app.get('/admin', (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  res.send(ADMIN_HTML);
});

module.exports = app;
if (require.main === module) {
  app.listen(3001, () => console.log('Admin app running on port 3001'));
  }
