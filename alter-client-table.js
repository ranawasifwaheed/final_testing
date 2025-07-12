require('dotenv').config();
const mysql = require('mysql2');

const db = mysql.createConnection({
    host: process.env.DB_HOST,
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
    database: process.env.DB_NAME
});

db.query('ALTER TABLE clients ADD COLUMN phonenumber VARCHAR(50)', (err) => {
    if (err) {
        console.error('Error altering clients table:', err);
    } else {
        console.log('✅ phonenumber column added to clients table.');
    }
    db.end();
});
