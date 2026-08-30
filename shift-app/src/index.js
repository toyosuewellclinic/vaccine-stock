import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';
import pkg from '@slack/bolt';
import { config } from './config.js';
import { registerCommands } from './slack/commands.js';
import { registerActions } from './slack/actions.js';
import { startReminders } from './scheduler/reminders.js';
import { createApiRouter } from './web/routes.js';

const { App, ExpressReceiver } = pkg;
const here = path.dirname(fileURLToPath(import.meta.url));

const receiver = new ExpressReceiver({
  signingSecret: config.slack.signingSecret,
  endpoints: '/slack/events',
  processBeforeResponse: true,
});

const app = new App({ token: config.slack.botToken, receiver });

registerCommands(app);
registerActions(app);

app.error(async (error) => {
  console.error('[slack]', error);
});

// 管理 Web UI（/admin）とその API（/api）
receiver.router.use('/api', createApiRouter(app));
receiver.router.use('/admin', express.static(path.join(here, 'web', 'public')));
receiver.router.get('/', (_req, res) => res.redirect('/admin/'));

await app.start(config.port);
console.log(`シフト作成アプリを起動しました: http://localhost:${config.port}/admin/`);
console.log(`Slack エンドポイント: /slack/events`);

startReminders(app);
