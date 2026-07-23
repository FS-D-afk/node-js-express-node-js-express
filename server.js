require('dotenv').config();
process.env.TZ = process.env.TZ || 'Asia/Shanghai';

const app = require('./src/app');
const { initDb } = require('./src/db');
const users = require('./src/services/users');

const port = process.env.PORT || 3000;

initDb()
  .then(() => users.removeExpiredSessions())
  .then(() => {
    app.listen(port, () => {
      console.log(`Campus digital vend running at http://localhost:${port}`);
    });
  })
  .catch((error) => {
    console.error('Failed to start app:', error);
    process.exit(1);
  });
