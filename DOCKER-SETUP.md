# Docker Setup Guide for brAIn.md

## Quick Start

### Prerequisites
- Docker and Docker Compose installed
- At least 4GB RAM available for containers
- Ports 3000, 6333, 8001 available

### 1. Configure Environment
```bash
cp .env.example .env
# Edit .env and set strong secrets:
# - USER_AUTH_SECRET
# - MCP_JWT_SECRET
```

### 2. Start Services
```bash
docker-compose up -d
```

This starts three services:
- **brain-app** (Next.js): http://localhost:3000
- **qdrant** (Vector DB): http://localhost:6333
- **jasper-embedder** (Embeddings): http://localhost:8001

### 3. Verify All Services Are Healthy
```bash
docker-compose ps
# All services should show "healthy" or "running"

docker-compose logs -f brain-app
# Wait for "ready - started server on" message
```

### 4. Register a User
Visit http://localhost:3000 and create an account (first user becomes admin)

### 5. Create an MCP Token (for LLM integration)
In the UI, go to Settings → MCP Tokens → Create
Copy the token and configure it in your LLM client.

## Architecture

### Volume Mounts
- `vault_storage:/app/vaults` — All user files and metadata (.vault-locks.json, .vault-index.json)
- `qdrant_storage:/qdrant/storage` — Vector database persistence
- `auth_storage:/app/.auth` — User credentials

### Network
All services communicate over the `brain-network` bridge:
- `brain-app` calls `qdrant:6333` and `jasper-embedder:8001`
- Both use internal DNS (no localhost needed)

### Health Checks
Each service has a health check:
- **Qdrant**: GET /health (curl)
- **Jasper**: GET /health (curl)
- **Brain App**: GET / (HTTP 200)

`docker-compose up` waits for Qdrant and Jasper to be healthy before starting brain-app.

## Common Operations

### View Logs
```bash
# All services
docker-compose logs -f

# Specific service
docker-compose logs -f brain-app
docker-compose logs -f qdrant
docker-compose logs -f jasper-embedder
```

### Stop Services
```bash
docker-compose down
```

Data persists in volumes, so starting again will restore the vault and database.

### Remove All Data (Clean Slate)
```bash
docker-compose down -v
```

### Inspect Vault Data
```bash
# List files
docker exec brain-app ls -la /app/vaults/

# View lock manifest
docker exec brain-app cat /app/vaults/<user-id>/.vault-locks.json

# View catalog
docker exec brain-app cat /app/vaults/<user-id>/.vault-index.json
```

### Scale Qdrant or Jasper (Optional)
Not currently configured for multiple replicas. For single-instance deployments, one of each service is sufficient.

## Troubleshooting

### Brain App Won't Start
1. Check logs: `docker-compose logs brain-app`
2. Verify environment variables: `docker-compose config | grep -E "QDRANT|JASPER"`
3. Ensure qdrant and jasper-embedder are healthy: `docker-compose logs qdrant` and `docker-compose logs jasper-embedder`

### Vector Search Not Working
1. Verify Jasper is running: `curl http://localhost:8001/health`
2. Verify Qdrant is running: `curl http://localhost:6333/health`
3. Check brain-app logs for embedder errors: `docker-compose logs brain-app | grep -i jasper`

### Locks Not Persisting
1. Verify vault_storage volume exists: `docker volume ls | grep vault_storage`
2. Check vault directory permissions: `docker exec brain-app ls -la /app/vaults/`
3. Verify lock file is being written: `docker exec brain-app cat /app/vaults/<user-id>/.vault-locks.json`

## Production Deployment

### Recommendations
1. **Secrets Management**: Use Docker secrets or a secrets manager (not .env files)
   ```bash
   echo "strong-random-secret" | docker secret create brain_jwt_secret -
   ```

2. **Persistent Volumes**: Use external volume drivers for redundancy
   ```yaml
   volumes:
     vault_storage:
       driver: local
       driver_opts:
         type: nfs
         o: addr=192.168.1.100,vers=4,soft,timeo=180,bg,tcp,rw
         device: ":/export/vault"
   ```

3. **Reverse Proxy**: Use Nginx or Traefik in front of brain-app for TLS and routing

4. **Monitoring**: Add Prometheus exporter and Grafana for metrics
   ```bash
   docker run prom/prometheus --config.file=/etc/prometheus/prometheus.yml
   docker run grafana/grafana
   ```

5. **Backup Strategy**: 
   - Regular snapshots of vault_storage and qdrant_storage volumes
   - Export user catalog and lock state to cold storage

### Environment Variables for Production
```bash
NODE_ENV=production
NEXT_PUBLIC_APP_URL=https://brain.example.com

# Use strong secrets!
USER_AUTH_SECRET=<generate-random-32-byte-hex>
MCP_JWT_SECRET=<generate-random-32-byte-hex>

# Optional: Qdrant API key for additional security
QDRANT_API_KEY=<generate-random-key>
```

## API Reference

### REST Endpoints
- `POST /api/auth/register` — Create account
- `POST /api/auth/login` — Start session
- `POST /api/auth/logout` — End session
- `GET /api/files` — List vault contents
- `POST /api/files` — Create file or folder
- `GET /api/files/[id]` — Get file content
- `POST /api/search` — Semantic search
- `POST /api/embed` — Embed text

### MCP Endpoints
- `POST /mcp` — JSON-RPC interface (requires JWT)

See [README.md](README.md) for full API documentation.

## Performance Tuning

### Increase Qdrant Memory
```yaml
services:
  qdrant:
    environment:
      QDRANT__STORAGE__SNAPSHOTS__SNAPSHOTS_PATH: /qdrant/snapshots
      QDRANT__STORAGE__TEMP_PATH: /qdrant/temp
```

### Increase Jasper Concurrency
```yaml
services:
  jasper-embedder:
    environment:
      JASPER_BATCH_SIZE: 32
```

### Tune Next.js
```yaml
services:
  brain-app:
    environment:
      NODE_OPTIONS: --max_old_space_size=2048
```

## Security Notes

- All container-to-container traffic is internal (no exposure to host except ports)
- Vault data is encrypted at rest if using encrypted volumes (depends on host filesystem)
- MCP tokens should be stored securely by LLM clients (not in version control)
- Lock enforcement is application-level; see [LOCKING.md](LOCKING.md) for details
