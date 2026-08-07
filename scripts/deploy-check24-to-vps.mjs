/**
 * Deploy CHECK24 integration to production VPS:
 * - upload local src/prisma/public/package files
 * - ensure CHECK24_* env on server
 * - rebuild API (entrypoint runs prisma migrate deploy)
 * - verify health + migration + CHECK24 status
 */
import { Client } from 'ssh2';
import { execSync } from 'child_process';
import { unlinkSync, writeFileSync, readFileSync } from 'fs';
import { join } from 'path';
import dotenv from 'dotenv';

dotenv.config();

const VPS_HOST = process.env.VPS_HOST || process.env.VPS_IP_ADDRESS || '85.214.41.33';
const VPS_USER = process.env.VPS_USER || process.env.VPS_USERNAME || 'root';
const VPS_PASS = process.env.VPS_PASSWORD;
const APP_DIR = process.env.DEPLOY_APP_DIR || '/root/fonio-middleware';
const DOMAIN = process.env.DOMAIN || 'vermietung.brainions.digital';
const ARCHIVE = join(process.cwd(), 'check24-deploy.tgz');

if (!VPS_PASS) {
  console.error('ERROR: VPS_PASSWORD missing in .env');
  process.exit(1);
}

const check24Token = process.env.CHECK24_API_TOKEN || '';
const check24Base =
  process.env.CHECK24_API_BASE_URL ||
  'https://supplyapistaging.ferienwohnung.check24-test.de/api/v2';
const webhookUser = process.env.CHECK24_WEBHOOK_USERNAME || 'check24';
const webhookPass =
  process.env.CHECK24_WEBHOOK_PASSWORD || 'change-me-check24-webhook';
const contactEmail =
  process.env.CHECK24_CONTACT_EMAIL ||
  process.env.ADMIN_EMAIL ||
  'vermietung@brainions.de';

console.log(`Packaging deploy archive → ${VPS_USER}@${VPS_HOST}:${APP_DIR}`);
execSync(
  'tar -czf check24-deploy.tgz package.json package-lock.json nest-cli.json tsconfig.json tsconfig.build.json src prisma public scripts/docker-entrypoint.sh .env.example docs/CHECK24.md',
  { stdio: 'inherit' },
);

function exec(conn, command, timeoutMs = 1_800_000) {
  return new Promise((resolve, reject) => {
    conn.exec(command, (err, stream) => {
      if (err) return reject(err);
      const timer = setTimeout(() => {
        stream.close();
        reject(new Error(`Timed out: ${command.slice(0, 80)}`));
      }, timeoutMs);
      let out = '';
      stream
        .on('close', (code) => {
          clearTimeout(timer);
          if (code === 0) resolve(out);
          else reject(new Error(`Failed (${code}): ${command.slice(0, 120)}\n${out}`));
        })
        .on('data', (d) => {
          const s = d.toString();
          out += s;
          process.stdout.write(s);
        })
        .stderr.on('data', (d) => {
          const s = d.toString();
          out += s;
          process.stderr.write(s);
        });
    });
  });
}

function upload(conn, localPath, remotePath) {
  return new Promise((resolve, reject) => {
    conn.sftp((err, sftp) => {
      if (err) return reject(err);
      sftp.fastPut(localPath, remotePath, (e) => (e ? reject(e) : resolve()));
    });
  });
}

function shellQuote(value) {
  return `'${String(value).replace(/'/g, `'\\''`)}'`;
}

const envPatchScript = `#!/bin/bash
set -e
cd ${APP_DIR}
ENV_FILE=.env
touch "$ENV_FILE"

upsert() {
  KEY="$1"
  VAL="$2"
  if grep -q "^\${KEY}=" "$ENV_FILE" 2>/dev/null; then
    awk -v k="$KEY" -v v="$VAL" 'BEGIN{FS=OFS="="} $1==k {$0=k"="v} {print}' "$ENV_FILE" > "$ENV_FILE.tmp"
    mv "$ENV_FILE.tmp" "$ENV_FILE"
  else
    printf '%s=%s\\n' "$KEY" "$VAL" >> "$ENV_FILE"
  fi
}

upsert CHECK24_ENABLED true
upsert CHECK24_API_TOKEN ${shellQuote(check24Token)}
upsert CHECK24_API_BASE_URL ${shellQuote(check24Base)}
upsert CHECK24_TERMS_URL 'https://brainions.digital/agb'
upsert CHECK24_HOST_TYPE professional
upsert CHECK24_PARTNER_DISPLAY_NAME 'brainions Vermietung'
upsert CHECK24_CONTACT_EMAIL ${shellQuote(contactEmail)}
upsert CHECK24_TEST_PROPERTY true
upsert CHECK24_ENQUIRY_ONLY false
upsert CHECK24_AUTO_ACCEPT_ENQUIRY true
upsert CHECK24_HOSTAWAY_CHANNEL_ID 2000
upsert CHECK24_PROPERTY_ID_PREFIX ha
upsert CHECK24_CANCEL_FREE_DAYS 14
upsert CHECK24_VAT_PERCENT 0
upsert CHECK24_WEBHOOK_USERNAME ${shellQuote(webhookUser)}
upsert CHECK24_WEBHOOK_PASSWORD ${shellQuote(webhookPass)}
upsert CHECK24_AUTO_SYNC false
upsert CHECK24_AUTO_SYNC_CONTENT false
upsert CHECK24_SYNC_INTERVAL_MINUTES 30
upsert CHECK24_BOOKING_POLL_INTERVAL_MINUTES 10
upsert CHECK24_SYNC_CONCURRENCY 2
upsert CHECK24_SYNC_DELAY_MS 200

echo "CHECK24 env keys:"
grep '^CHECK24_' "$ENV_FILE" | sed 's/=.*/=***/' || true
`;

const conn = new Client();
conn
  .on('ready', async () => {
    try {
      console.log('\n=== Upload ===\n');
      await upload(conn, ARCHIVE, '/tmp/check24-deploy.tgz');

      console.log('\n=== Extract (preserve .env) ===\n');
      await exec(
        conn,
        `set -e
cd ${APP_DIR}
cp -a .env /tmp/fonio-env.backup
tar -xzf /tmp/check24-deploy.tgz -C ${APP_DIR}
cp /tmp/fonio-env.backup .env
sed -i 's/\\r$//' scripts/docker-entrypoint.sh
chmod +x scripts/docker-entrypoint.sh
rm -f /tmp/check24-deploy.tgz /tmp/fonio-env.backup
test -f prisma/migrations/20260806120000_check24_integration/migration.sql
test -d src/check24
ls src/check24 | head
echo EXTRACT_OK`,
        120_000,
      );

      console.log('\n=== Patch CHECK24 .env ===\n');
      writeFileSync('tmp-check24-env-patch.sh', envPatchScript.replace(/\r\n/g, '\n'));
      await upload(conn, 'tmp-check24-env-patch.sh', '/tmp/check24-env-patch.sh');
      await exec(conn, 'sed -i "s/\\r$//" /tmp/check24-env-patch.sh && bash /tmp/check24-env-patch.sh && rm -f /tmp/check24-env-patch.sh', 60_000);

      console.log('\n=== Rebuild API (migrate on start) ===\n');
      await exec(
        conn,
        `cd ${APP_DIR} && docker compose -f docker-compose.prod.yml up -d --build api`,
        1_800_000,
      );

      console.log('\n=== Verify ===\n');
      const verifyOut = await exec(
        conn,
        `set -e
sleep 25
cd ${APP_DIR}
docker compose -f docker-compose.prod.yml ps
echo '--- health ---'
curl -fsS https://${DOMAIN}/health
echo
echo '--- api logs ---'
docker compose -f docker-compose.prod.yml logs api --tail 50
echo '--- migrations ---'
docker compose -f docker-compose.prod.yml exec -T postgres psql -U vermietung -d vermietung -c "SELECT migration_name, finished_at FROM _prisma_migrations WHERE migration_name LIKE '%check24%' OR migration_name LIKE '%20260806%' ORDER BY finished_at DESC;"
echo '--- tables ---'
docker compose -f docker-compose.prod.yml exec -T postgres psql -U vermietung -d vermietung -c "\\dt \\"Check24*\\""
`,
        300_000,
      );

      // Login + CHECK24 status if admin credentials available locally
      const adminEmail = process.env.ADMIN_EMAIL;
      const adminPassword = process.env.ADMIN_PASSWORD;
      if (adminEmail && adminPassword) {
        console.log('\n=== CHECK24 status via API ===\n');
        const loginBody = JSON.stringify({
          email: adminEmail,
          password: adminPassword,
        });
        writeFileSync('tmp-check24-verify.json', loginBody);
        // Run verification from local machine against public URL
        const loginRes = execSync(
          `node -e "const https=require('https');const data=process.argv[1];const u=new URL('https://${DOMAIN}/api/v1/admin/auth/login');const req=https.request(u,{method:'POST',headers:{'Content-Type':'application/json','Content-Length':Buffer.byteLength(data)}},res=>{let d='';res.on('data',c=>d+=c);res.on('end',()=>{console.log(d);if(res.statusCode>=400)process.exit(1);});});req.on('error',e=>{console.error(e);process.exit(1)});req.write(data);req.end();" ${JSON.stringify(loginBody)}`,
          { encoding: 'utf8' },
        );
        const token = JSON.parse(loginRes).accessToken;
        if (!token) throw new Error('No accessToken from admin login');
        const statusRes = execSync(
          `node -e "const https=require('https');const token=process.argv[1];const u=new URL('https://${DOMAIN}/api/v1/admin/check24/status');const req=https.request(u,{method:'GET',headers:{Authorization:'Bearer '+token}},res=>{let d='';res.on('data',c=>d+=c);res.on('end',()=>{console.log(d);process.exit(res.statusCode>=400?1:0);});});req.on('error',e=>{console.error(e);process.exit(1)});req.end();" ${JSON.stringify(token)}`,
          { encoding: 'utf8' },
        );
        console.log(statusRes);
        writeFileSync('tmp-check24-status.json', statusRes);
      } else {
        console.log('ADMIN_EMAIL/PASSWORD missing locally — skipped authenticated CHECK24 status check');
      }

      console.log('\n=== Deploy finished ===\n');
      console.log(verifyOut.slice(-500));
    } catch (error) {
      console.error('\nDEPLOY FAILED:', error.message);
      process.exitCode = 1;
    } finally {
      for (const f of [ARCHIVE, 'tmp-check24-env-patch.sh', 'tmp-check24-verify.json']) {
        try {
          unlinkSync(f);
        } catch {}
      }
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
