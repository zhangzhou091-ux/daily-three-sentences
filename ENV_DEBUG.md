# 环境变量调试指南

## 问题诊断

反复出现 "云端服务未配置" 提示，可能原因：

### 1. 环境变量未生效 ✅
- **症状**: 控制台显示 `VITE_SUPABASE_URL: ❌ 未设置`
- **解决**: 重启开发服务器 `npm run dev`

### 2. URL 或 Key 格式错误 ✅
- **症状**: `Invalid supabaseUrl` 错误
- **检查**: 
  - URL 必须是完整 URL: `https://enaovozvdpivbhjoetkp.supabase.co`
  - Key 必须以 `sb_` 开头

### 3. .env.local 文件位置错误 ✅
- **必须位于项目根目录**: `c:\Users\Administrator\Desktop\daily-three-sentences\.env.local`

## 当前配置检查

运行 `npm run dev` 后，查看控制台输出：

```bash
🔍 环境变量检查:
VITE_SUPABASE_URL: https://enaovozvdpivbhjoetkp.supabase.co
VITE_SUPABASE_ANON_KEY: ✅ 已设置
```

## 验证步骤

1. **确认文件存在**
   ```bash
   ls .env.local
   ```

2. **重启开发服务器**
   ```bash
   npm run dev
   ```

3. **检查控制台输出**
   - 应该看到 `✅ Supabase 客户端初始化成功`
   - 不应该看到 `❌ Supabase 初始化失败`

4. **测试连接**
   - 打开设置页面
   - 填写用户名后点击"连接数据库"
   - 应该显示 "✅ 已连接用户：xxx"

## 常见错误

### 404 Not Found
- 检查 Supabase 项目是否正确创建
- 检查数据库表是否已创建（`sentences`, `user_stats`）

### Invalid supabaseUrl
- URL 必须包含 `https://`
- URL 必须指向有效的 Supabase 项目

### Key 格式错误
- 公钥（anon key）格式: `sb_publishable_xxx`
- 私钥（service role key）格式: `sb_secret_xxx`
