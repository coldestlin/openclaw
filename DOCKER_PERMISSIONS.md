# OpenClaw Docker 权限配置说明

## 当前配置

### 用户权限

- **运行用户**: `node` (非 root 用户)
- **安全考虑**: 遵循最小权限原则，提高容器安全性

### 已安装的工具

#### 文本处理工具（OpenClaw DEFAULT_SAFE_BINS）

```bash
jq      # JSON 处理
grep    # 文本搜索
cut     # 文本切割
sort    # 排序
uniq    # 去重
head    # 文件头部
tail    # 文件尾部
tr      # 字符转换
wc      # 字数统计
```

#### 网络工具

```bash
curl               # HTTP/HTTPS 客户端
wget               # 文件下载
telnet             # Telnet 客户端
nc (netcat)        # 网络调试工具
dig, nslookup      # DNS 查询
ping               # ICMP ping
```

#### 系统工具

```bash
xxd (vim-common)   # 十六进制转储工具
netstat, ifconfig  # 网络工具
ip                 # 网络配置
ps, top, kill      # 进程工具
file               # 文件类型检测
```

## 权限问题解决方案

### 1. 当前权限设置

```dockerfile
# Dockerfile 中
USER node
WORKDIR /app
```

### 2. 临时目录权限

```bash
# entrypoint.sh 中自动设置
mkdir -p /tmp/openclaw
chmod 1777 /tmp/openclaw
```

### 3. 工作区权限

```bash
# entrypoint.sh 中自动设置
chown -R node:node /data/workspace 2>/dev/null || true
```

## 是否需要 Root 用户？

### 一般情况：不需要

OpenClaw 在 `node` 用户下可以正常运行，因为：

- Gateway 端口 18789 > 1024，不需要特权端口
- 大部分工具在普通用户权限下可用
- 文件操作限制在 `/app` 和 `/data` 目录

### 特殊情况：可能需要

如果遇到以下情况，可能需要特殊处理：

#### 1. Docker-in-Docker

如果需要在容器内运行 Docker：

```bash
# 运行容器时添加
docker run --privileged -v /var/run/docker.sock:/var/run/docker.sock ...
```

#### 2. 网络特权操作

如果需要修改网络配置：

```bash
# 运行容器时添加
docker run --cap-add=NET_ADMIN ...
```

#### 3. 系统级操作

如果需要执行某些系统命令：

```dockerfile
# 在 Dockerfile 中添加 sudo
RUN apt-get update && apt-get install -y sudo
```

## 常见问题

### Q1: `xxd: Permission denied`

**原因**: 缺少 `vim-common` 包
**解决**: 已在 Dockerfile 中添加 `vim-common`

### Q2: `grep: command not found`

**原因**: 缺少基础工具
**解决**: 已在 Dockerfile 中添加所有必要工具

### Q3: `Permission denied` 写入文件

**原因**: 目录权限不足
**解决**:

```bash
# 运行时设置权限
chown -R node:node /data/workspace
chmod 755 /data/workspace
```

### Q4: 需要绑定特权端口

**原因**: 端口 < 1024 需要 root
**解决**:

```bash
# 方法1: 使用非特权端口（推荐）
# Gateway 默认使用 18789，无需修改

# 方法2: 使用 setcap
RUN setcap 'cap_net_bind_service=+ep' $(readlink -f $(which node))
```

## 安全最佳实践

### 1. 保持非 root 用户运行

```dockerfile
# ✅ 推荐
USER node

# ❌ 不推荐（除非必要）
USER root
```

### 2. 使用 capabilities 而不是完全特权

```bash
# ✅ 推荐：只添加必要的 capabilities
docker run --cap-add=NET_ADMIN ...

# ❌ 不推荐：完全特权
docker run --privileged ...
```

### 3. 限制文件系统访问

```bash
# 使用只读文件系统（除了必要的目录）
docker run --read-only --tmpfs /tmp ...
```

### 4. 使用资源限制

```bash
# 限制内存和 CPU
docker run -m 2g --cpus="2" ...
```

## 调试权限问题

### 检查当前用户

```bash
whoami
# 输出: node
```

### 检查目录权限

```bash
ls -la /data
ls -la /app
```

### 检查工具可用性

```bash
which xxd
which grep
which jq
```

### 测试工具执行

```bash
echo "test" | xxd
echo "test" | grep "test"
echo '{"key":"value"}' | jq .
```

## 构建和测试

### 构建镜像

```bash
cd /home/gee/projects/gee/openclaw-debug
docker build -t openclaw:latest .
```

### 测试镜像

```bash
docker run --rm -it openclaw:latest bash
# 在容器内测试
which xxd
which grep
echo "test" | xxd
```

### 运行容器

```bash
docker run -d \
  --name openclaw \
  -p 18789:18789 \
  -v openclaw-data:/data \
  -e INSTANCE_SECRET=your-secret \
  openclaw:latest
```

## 总结

1. **默认配置**: 使用 `node` 用户运行，安全性高
2. **工具完整**: 已添加所有 OpenClaw 需要的工具
3. **权限优化**: entrypoint.sh 自动处理权限问题
4. **特殊情况**: 如需特权操作，使用 capabilities 或 volume mounts
5. **安全优先**: 保持非 root 用户，只在必要时提升权限

如果遇到具体的权限问题，请检查：

- 工具是否已安装 (`which <tool>`)
- 目录权限 (`ls -la <dir>`)
- 是否需要特殊 capabilities
