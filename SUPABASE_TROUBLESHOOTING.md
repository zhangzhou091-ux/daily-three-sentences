# Supabase 连接问题诊断与解决方案

## 问题现象

反复调整后仍出现以下错误：

1. ❌ "云端服务未配置" 提示
2. ❌ 控制台报错: `Supabase initialization failed`
3. ❌ `Invalid supabaseUrl` 错误
4. ❌ `404 Not Found` 错误

## 根本原因分析

### 1. 环境变量未生效（最常见）

**症状**: 控制台显示 `⚠️ Supabase 配置缺失`

**原因**: 
- Vite 只在启动时读取 `.env.local` 文件
- 修改文件后必须重启开发服务器才能生效

**解决方案**:
```bash
# 停止当前服务器 (Ctrl+C)
# 然后重启
npm run dev
```

### 2. 环境变量文件格式错误

**检查 `.env.local` 文件**:

```bash
# 必须位于项目根目录
c:\Users\Administrator\Desktop\daily-three-sentences\.env.local

# 文件内容（注意：不能有额外空格或换行）
VITE_SUPABASE_URL=https://enaovozvdpivbhjoetkp.supabase.co
VITE_SUPABASE_ANON_KEY=sb_publishable_XSSE5uw_UPFDXLQIUEv9MA_TB-ZAdfu
```

**常见错误**:
- ❌ 文件名不是 `.env.local`（比如 `.env.local.txt`）
- ❌ URL 或 Key 后面有多余空格
- ❌ 使用中文标点符号
- ❌ 文件编码不是 UTF-8

### 3. URL 或 Key 格式不正确

**正确的格式**:

```typescript
// ✅ 正确
VITE_SUPABASE_URL=https://enaovozvdpivbhjoetkp.supabase.co
VITE_SUPABASE_ANON_KEY=sb_publishable_XSSE5uw_UPFDXLQIUEv9MA_TB-ZAdfu

// ❌ 错误（缺少 https://）
VITE_SUPABASE_URL=enaovozvdpivbhjoetkp.supabase.co

// ❌ 错误（Key 格式不对）
VITE_SUPABASE_ANON_KEY=your-anon-key
```

### 4. Supabase 项目配置问题

**检查 Supabase 控制台**:

1. 登录 https://supabase.com
2. 进入你的项目 `enaovozvdpivbhjoetkp`
3. 打开 Project Settings → API
4. 确认以下信息：
   - Project URL: `https://enaovozvdpivbhjoetkp.supabase.co`
   - Public API key (anon): `sb_publishable_XSSE5uw_UPFDXLQIUEv9MA_TB-ZAdfu`
   - ✅ API 已启用
   - ✅ 数据库表已创建：`sentences`, `user_stats`, `dictation_records`, `performance_metrics`

## 诊断步骤

### 步骤 1: 检查环境变量

打开浏览器控制台（F12），应该看到：

```bash
🔍 环境变量检查:
VITE_SUPABASE_URL: https://enaovozvdpivbhjoetkp.supabase.co
VITE_SUPABASE_ANON_KEY: ✅ 已设置
当前环境: development
开发模式: ✅ 是
```

### 步骤 2: 检查 Supabase 初始化

控制台应该显示：

```bash
✅ Supabase 客户端初始化成功
```

如果看到：

```bash
⚠️ Supabase 配置缺失
   URL: 未设置
   KEY: 未设置
```

说明环境变量未生效，需要重启开发服务器。

### 步骤 3: 检查 SettingsPage

打开设置页面，应该看到"环境诊断"面板：

- ✅ Supabase URL: 显示正确的 URL
- ✅ API Key: 显示"已配置"
- ✅ 环境: DEV 和 PROD 标签正确显示

### 步骤 4: 测试连接

1. 在设置页面填写用户名
2. 点击"连接数据库"
3. 应该显示: `✅ 已连接用户：xxx`

## 解决方案

### 方案 1: 重启开发服务器（90% 的情况）

```bash
# 停止当前服务器
Ctrl + C

# 重新启动
npm run dev
```

### 方案 2: 清除缓存

```bash
# 删除 node_modules 缓存
rm -rf node_modules/.vite

# 重新安装依赖
npm install

# 重启开发服务器
npm run dev
```

### 方案 3: 手动配置（临时方案）

如果环境变量仍然不生效，可以在设置页面手动输入：

1. 打开设置页面
2. 在"Supabase Project URL"中输入：
   ```
   https://enaovozvdpivbhjoetkp.supabase.co
   ```
3. 在"Anon Key"中输入：
   ```
   sb_publishable_XSSE5uw_UPFDXLQIUEv9MA_TB-ZAdfu
   ```
4. 填写用户名
5. 点击"连接数据库"

## 验证成功

成功后应该看到：

1. ✅ 控制台显示 `✅ Supabase 客户端初始化成功`
2. ✅ SettingsPage 显示"云同步已激活"
3. ✅ 顶部显示 `SYNC ON`
4. ✅ 设置页面显示"已连接用户：xxx"

## 常见错误代码

### 401 Unauthorized
- **原因**: API Key 不正确
- **解决**: 检查 `.env.local` 中的 `VITE_SUPABASE_ANON_KEY`

### 404 Not Found
- **原因**: URL 不正确或数据库表不存在
- **解决**: 
  1. 检查 URL 格式
  2. 在 Supabase 控制台检查表是否存在

### Network Error
- **原因**: 网络连接问题
- **解决**: 检查网络连接，尝试访问 Supabase 控制台

## 调试工具

项目已添加以下调试工具：

1. **环境变量检查** (`src/services/envCheck.ts`)
   - 在控制台显示环境变量状态

2. **Supabase 服务增强日志** (`src/services/supabaseService.ts`)
   - 详细的初始化日志
   - 错误信息包含 URL 和 Key 状态

3. **环境诊断面板** (`src/components/EnvCheckPanel.tsx`)
   - 在 SettingsPage 中显示环境配置状态

## 总结

**最可能的原因**: 环境变量文件修改后没有重启开发服务器

**最快的解决方法**:
```bash
# 停止服务器 (Ctrl+C)
# 重启
npm run dev
```

**验证方法**:
1. 打开浏览器控制台
2. 查看是否显示 `✅ Supabase 客户端初始化成功`
3. 打开 SettingsPage，查看"环境诊断"面板
