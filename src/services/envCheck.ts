export function checkEnv() {
  console.log('🔍 环境变量检查:');
  console.log('VITE_SUPABASE_URL:', import.meta.env.VITE_SUPABASE_URL || '❌ 未设置');
  console.log('VITE_SUPABASE_ANON_KEY:', import.meta.env.VITE_SUPABASE_ANON_KEY ? '✅ 已设置' : '❌ 未设置');
  console.log('当前环境:', import.meta.env.MODE || 'default');
  console.log('开发模式:', import.meta.env.DEV ? '✅ 是' : '❌ 否');
  console.log('生产模式:', import.meta.env.PROD ? '✅ 是' : '❌ 否');
}
