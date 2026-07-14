#!/usr/bin/env node
/**
 * Deploy local HEAD to VPS: rsync via git archive + SSH password,
 * or reset to remote if available; always rebuild Docker.
 */
import { Client } from 'ssh2';
import { execSync } from 'child_process';
import { readFileSync, writeFileSync, unlinkSync } from 'fs';
import { join } from 'path';

const VPS_HOST = process.env.VPS_HOST ?? '85.214.41.33';
const VPS_USER = process.env.VPS_USER ?? 'root';
const VPS_PASS = process.env.VPS_PASSWORD;
const APP_DIR = process.env.DEPLOY_APP_DIR ?? '/root/fonio-middleware';
const DOMAIN = process.env.DOMAIN ?? 'vermietung.brainions.digital';
const ARCHIVE = join(process.cwd(), 'deploy-bundle.tgz');

if (!VPS_PASS) {
  console.error('ERROR: Set VPS_PASSWORD');
  process.exit(1);
}

function exec(conn, command, timeoutMs = 1_800_000) {
  return new Promise((resolve, reject) => {
    conn.exec(command, (err, stream) => {
      if (err) return reject(err);
      const timer = setTimeout(() => {
        stream.close();
        reject(new Error(`Timed out: ${command}`));
      }, timeoutMs);
      stream
        .on('close', (code) => {
          clearTimeout(timer);
          if (code === 0) resolve();
          else reject(new Error(`Failed (${code}): ${command}`));
        })
        .on('data', (d) => process.stdout.write(d.toString()))
        .stderr.on('data', (d) => process.stderr.write(d.toString()));
    });
  });
}

function upload(conn, localPath, remotePath) {
  return new Promise((resolve, reject) => {
    conn.sftp((err, sftp) => {
      if (err) return reject(err);
      sftp.fastPut(localPath, remotePath, (e) => {
        if (e) reject(e);
        else resolve();
      });
    });
  });
}

console.log('Creating git archive of HEAD...');
execSync(`git archive --format=tar.gz -o "${ARCHIVE}" HEAD`, { stdio: 'inherit' });

const conn = new Client();
conn
  .on('ready', async () => {
    try {
      console.log('\n=== Upload archive ===\n');
      await upload(conn, ARCHIVE, '/tmp/fonio-deploy.tgz');

      console.log('\n=== Extract into app dir (preserve .env) ===\n');
      await exec(
        conn,
        `set -e
cd "${APP_DIR}"
cp .env /tmp/fonio-env.backup
# remove tracked files carefully: extract over tree
tar -xzf /tmp/fonio-deploy.tgz -C "${APP_DIR}"
cp /tmp/fonio-env.backup .env
sed -i 's/\\r$//' scripts/docker-entrypoint.sh
chmod +x scripts/docker-entrypoint.sh
rm -f /tmp/fonio-deploy.tgz /tmp/fonio-env.backup
git status || true
echo HEAD_LOCAL_DEPLOYED`,
        120_000,
      );

      console.log('\n=== Rebuild containers (migrations on start) ===\n');
      await exec(
        conn,
        `cd "${APP_DIR}" && docker compose -f docker-compose.prod.yml up -d --build`,
        1_800_000,
      );

      console.log('\n=== Verify ===\n');
      await exec(
        conn,
        `sleep 30
cd "${APP_DIR}"
docker compose -f docker-compose.prod.yml ps
docker compose -f docker-compose.prod.yml logs api --tail 35
curl -fsS https://${DOMAIN}/health
docker compose -f docker-compose.prod.yml exec -T postgres psql -U vermietung -d vermietung -c "SELECT migration_name, finished_at FROM _prisma_migrations ORDER BY finished_at DESC LIMIT 5;"`,
        180_000,
      );

      console.log('\n=== Deploy finished ===\n');
    } catch (error) {
      console.error('\nDEPLOY FAILED:', error.message);
      process.exitCode = 1;
    } finally {
      try {
        unlinkSync(ARCHIVE);
      } catch {}
      conn.end();
    }
  })
  .on('error', (err) => {
    console.error('SSH error:', err.message);
    try {
      unlinkSync(ARCHIVE);
    } catch {}
    process.exit(1);
  })
  .connect({
    host: VPS_HOST,
    port: 22,
    username: VPS_USER,
    password: VPS_PASS,
    readyTimeout: 30_000,
    algorithms: {
      serverHostKey: ['ssh-rsa', 'ssh-ed25519', 'ecdsa-sha2-nistp256'],
    },
  });
