import { config } from './config.js';
import { createApp } from './app.js';

const app = createApp();
app.listen(config.port, config.host, () => {
  console.log(`Server listening on http://${config.host}:${config.port}`);
});
