import { createClient } from '@supabase/supabase-js';
import { config } from '../config.js';

// service_role キーを使うためサーバー側でのみ生成する。ブラウザには絶対に渡さない。
export const supabase = createClient(config.supabase.url, config.supabase.serviceRoleKey, {
  auth: { persistSession: false, autoRefreshToken: false },
});

export function unwrap({ data, error }, context) {
  if (error) throw new Error(`${context}: ${error.message}`);
  return data;
}
