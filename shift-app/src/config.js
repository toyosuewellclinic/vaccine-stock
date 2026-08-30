import 'dotenv/config';

function required(name) {
  const v = process.env[name];
  if (!v) throw new Error(`環境変数 ${name} が設定されていません（.env.example を参照）`);
  return v;
}

function num(name, fallback) {
  const v = process.env[name];
  if (v === undefined || v === '') return fallback;
  const n = Number(v);
  if (Number.isNaN(n)) throw new Error(`環境変数 ${name} は数値で指定してください`);
  return n;
}

export const config = {
  slack: {
    botToken: required('SLACK_BOT_TOKEN'),
    signingSecret: required('SLACK_SIGNING_SECRET'),
    shiftChannel: required('SLACK_SHIFT_CHANNEL'),
    get adminChannel() {
      return process.env.SLACK_ADMIN_CHANNEL || this.shiftChannel;
    },
  },
  supabase: {
    url: required('SUPABASE_URL'),
    serviceRoleKey: required('SUPABASE_SERVICE_ROLE_KEY'),
  },
  admin: {
    token: required('ADMIN_TOKEN'),
  },
  port: num('PORT', 3000),
  timezone: process.env.TZ_NAME || 'Asia/Tokyo',
  rules: {
    minRestHours: num('MIN_REST_HOURS', 11),
    defaultMaxConsecutiveDays: num('DEFAULT_MAX_CONSECUTIVE_DAYS', 5),
  },
  cron: {
    enabled: (process.env.ENABLE_CRON ?? 'true') !== 'false',
    deadlineReminder: process.env.CRON_DEADLINE_REMINDER || '0 9 * * *',
    tomorrowReminder: process.env.CRON_TOMORROW_REMINDER || '0 18 * * *',
  },
};
