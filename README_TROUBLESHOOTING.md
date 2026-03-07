# 🔍 Supabase 连接问题诊断指南

## 🚀 快速诊断（3 分钟）

### 步骤 1: 访问诊断页面

在浏览器中访问：
```
http://localhost:5173/env-test
```

如果看到"环境变量诊断"页面，说明项目正在运行。

### 步骤 2: 检查环境变量

在诊断页面或浏览器控制台（F12）中，你应该看到：

```bash
🔍 环境变量检查:
VITE_SUPABASE_URL: https://enaovozvdpivbhjoetkp.supabase.co
VITE_SUPABASE_ANON_KEY: ✅ 已设置
```

### 步骤 3: 检查 Supabase 初始化

在浏览器控制台中，应该看到：

```bash
✅ Supabase 客户端初始化成功
```

## ❌ 问题诊断

### 问题 1: "云端服务未配置"

**症状**: 
- 设置页面显示 "云端服务未配置（请检查 .env）"
- 控制台显示 `⚠️ Supabase 配置缺失`

**原因**: 环境变量未生效

**解决**: 
```bash
# 停止开发服务器 (Ctrl+C)
# 重新启动
npm run dev
```

### 问题 2: "Invalid supabaseUrl"

**症状**: 
- 控制台显示 `Invalid supabaseUrl`

**原因**: URL 格式不正确

**检查**:
- URL 必须包含 `https://`
- URL 必须是完整的 Supabase 项目 URL

### 问题 3: "404 Not Found"

**症状**: 
- API 请求返回 404 错误

**原因**: 
- URL 不正确
- 数据库表不存在

**检查**:
1. 登录 Supabase 控制台
2. 检查项目 URL
3. 确认表已创建：`sentences`, `user_stats`

## ✅ 验证成功

成功后应该看到：

1. ✅ 控制台显示 `✅ Supabase 客户端初始化成功`
2. ✅ SettingsPage 显示 "云同步已激活"
3. ✅ 顶部显示 "SYNC ON"
4. ✅ 可以正常同步数据

## 📋 检查清单

- [ ] `.env.local` 文件存在于项目根目录
- [ ] 文件内容格式正确（无多余空格）
- [ ] 开发服务器已重启
- [ ] 控制台显示环境变量信息
- [ ] Supabase 项目 URL 正确
- [ ] Supabase API Key 正确
- [ ] 数据库表已创建

## 🆘 临时解决方案

如果环境变量仍然不生效，可以在设置页面手动配置：

1. 打开设置页面
2. 填写以下信息：
   - Supabase Project URL: `https://enaovozvdpivbhjoetkp.supabase.co`
   - Anon Key: `sb_publishable_XSSE5uw_UPFDXLQIUEv9MA_TB-ZAdfu`
   - 用户昵称: 你的名字
3. 点击"连接数据库"

## 📚 相关文档

- [详细故障排除指南](./SUPABASE_TROUBLESHOOTING.md)
- [环境变量说明](./ENV_DEBUG.md)

## 💡 提示

**最常见的原因**: 修改 `.env.local` 后没有重启开发服务器

**最快的解决方法**:
```bash
# 停止服务器 (Ctrl+C)
# 重启
npm run dev
```
