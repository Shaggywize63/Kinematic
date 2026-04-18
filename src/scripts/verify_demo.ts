
import axios from 'axios';

const API_URL = 'http://localhost:3000/api/v1'; // Adjust if different
const DEMO_EMAIL = 'demo@kinematic.com';
const DEMO_PASSWORD = 'kinematic-demo-2024';

async function verifyDemoAccount() {
  console.log('🚀 Starting Demo Account Verification...');

  try {
    // 1. Login
    console.log('\n--- 1. Testing Login ---');
    const loginRes = await axios.post(`${API_URL}/auth/login`, {
      email: DEMO_EMAIL,
      password: DEMO_PASSWORD
    });

    if (loginRes.data.success && loginRes.data.user.id === 'demo-user-id') {
      console.log('✅ Login Successful. Demo User Identified.');
    } else {
      console.error('❌ Login Failed or User ID Mismatch');
      return;
    }

    const token = loginRes.data.access_token;
    const config = { headers: { Authorization: `Bearer ${token}` } };

    // 2. Analytics Summary
    console.log('\n--- 2. Testing Analytics Summary ---');
    const summaryRes = await axios.get(`${API_URL}/analytics/summary`, config);
    if (summaryRes.data.success && summaryRes.data.data.kpis.total_tff === 1248) {
      console.log('✅ Analytics Summary Mocked Correctly.');
    } else {
      console.error('❌ Analytics Summary Mock Failed');
    }

    // 3. Attendance Today
    console.log('\n--- 3. Testing Attendance Today ---');
    const attRes = await axios.get(`${API_URL}/analytics/attendance-today`, config);
    if (attRes.data.success && attRes.data.data.summary.total === 145) {
      console.log('✅ Attendance Today Mocked Correctly.');
    } else {
      console.error('❌ Attendance Today Mock Failed');
    }

    // 4. Form Templates
    console.log('\n--- 4. Testing Form Templates ---');
    const formsRes = await axios.get(`${API_URL}/forms/templates`, config);
    if (formsRes.data.success && formsRes.data.data.length > 0 && formsRes.data.data[0].name === 'Daily Store Audit') {
      console.log('✅ Form Templates Mocked Correctly.');
    } else {
      console.error('❌ Form Templates Mock Failed');
    }

    // 5. Check-in (Stub)
    console.log('\n--- 5. Testing Check-in Stub ---');
    const checkinRes = await axios.post(`${API_URL}/attendance/checkin`, {
      latitude: 12.97,
      longitude: 77.59
    }, config);
    if (checkinRes.data.success && checkinRes.data.data.id === 'demo-att-id') {
      console.log('✅ Check-in Stub Successful.');
    } else {
      console.error('❌ Check-in Stub Failed');
    }

    console.log('\n✨ Demo Account Verification Complete!');
  } catch (error: any) {
    console.error('❌ Error during verification:', error.response?.data || error.message);
  }
}

// verifyDemoAccount(); // Uncomment to run if server is local
console.log('Verification script ready. Run against a local server to confirm.');
