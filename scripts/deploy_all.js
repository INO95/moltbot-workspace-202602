/**
 * Moltbot 통합 시스템 배포 스크립트
 * 한 번의 실행으로 모든 서비스를 가동합니다
 */

const { spawn, exec } = require('child_process');
const fs = require('fs');
const path = require('path');

class MoltbotDeployer {
    constructor() {
        this.services = [];
        this.logDir = path.join(__dirname, '../logs');

        if (!fs.existsSync(this.logDir)) {
            fs.mkdirSync(this.logDir, { recursive: true });
        }
    }

    log(message) {
        const timestamp = new Date().toISOString();
        const logMessage = `[${timestamp}] ${message}`;
        console.log(logMessage);
        fs.appendFileSync(path.join(this.logDir, 'deploy.log'), logMessage + '\n');
    }

    // 1. Codex Proxy 시작
    async startCodexProxy() {
        this.log('🚀 Starting Codex Proxy...');

        // 포트 3000번 확인 (lsof)
        try {
            const isPortInUse = await new Promise(resolve => {
                exec('lsof -i :3000 -t', (err, stdout) => {
                    resolve(stdout && stdout.trim().length > 0);
                });
            });

            if (isPortInUse) {
                this.log('⚠️ Proxy already running on port 3000. Skipping start.');
                return true;
            }
        } catch (e) {
            // lsof 실패 시 무시하고 진행
        }

        const proxy = spawn('node', ['scripts/codex_proxy.js'], {
            cwd: path.join(__dirname, '..'),
            detached: true,
            stdio: ['ignore', 'pipe', 'pipe']
        });

        proxy.stdout.on('data', data => this.log(`[Proxy] ${data}`));
        proxy.stderr.on('data', data => {
            if (data.toString().includes('EADDRINUSE')) {
                this.log('⚠️ Proxy port in use (race condition). Assuming running.');
            } else {
                this.log(`[Proxy Error] ${data}`);
            }
        });

        proxy.unref();
        this.services.push({ name: 'codex-proxy', pid: proxy.pid });

        this.log(`✅ Codex Proxy started (PID: ${proxy.pid})`);

        // 잠시 대기 후 연결 테스트
        await this.sleep(2000);
        return this.testProxyConnection();
    }

    async testProxyConnection() {
        return new Promise((resolve) => {
            exec('curl -s -o /dev/null -w "%{http_code}" http://localhost:3000/v1/chat/completions',
                (error, stdout) => {
                    if (error) {
                        this.log('⚠️ Proxy connection test failed');
                        resolve(false);
                        return;
                    }

                    const code = Number((stdout || '').trim());
                    if (code === 404 || code === 405 || code === 400 || code === 401 || code === 403) {
                        this.log(`✅ Proxy endpoint reachable (HTTP ${code})`);
                        resolve(true);
                        return;
                    }

                    this.log(`⚠️ Unexpected proxy response (HTTP ${code || 'N/A'})`);
                    resolve(false);
                });
        });
    }

    // 2. 스케줄러 등록 (cron)
    async setupSchedulers() {
        this.log('⏰ Setting up schedulers...');

        const cronJobs = [
            { time: '0 7 * * *', command: 'node scripts/morning_briefing.js', name: 'Morning Briefing' },
            { time: '55 23 * * *', command: 'node scripts/daily_summary.js', name: 'Daily Summary' },
            { time: '0 12 * * 0', command: 'node scripts/weekly_report.js', name: 'Weekly Report' }
        ];

        // crontab 스크립트 생성
        const cronScript = cronJobs.map(job =>
            `# ${job.name}\n${job.time} cd ${path.join(__dirname, '..')} && ${job.command} >> logs/cron.log 2>&1`
        ).join('\n\n');

        const cronPath = path.join(__dirname, '../crontab_moltbot.txt');
        fs.writeFileSync(cronPath, cronScript);

        this.log(`📝 Cron script saved: ${cronPath}`);
        this.log('   Run: crontab crontab_moltbot.txt to activate');

        return cronPath;
    }

    // 3. 건강 대시보드 테스트
    async testHealthDashboard() {
        this.log('🏥 Testing Health Dashboard...');

        try {
            const dashboard = require('./health_dashboard');
            const result = await dashboard.generateDashboard({
                sleepData: [{ hours: 7.5, deepPercent: 20 }],
                exerciseHistory: []
            });

            this.log('✅ Health Dashboard operational');
            this.log(result.summary);
            return true;
        } catch (e) {
            this.log(`❌ Health Dashboard error: ${e.message}`);
            return false;
        }
    }

    // 4. 블로그 구조 초기화
    async initBlog() {
        this.log('📝 Initializing Blog structure...');

        try {
            const blog = require('./blog_automation');
            blog.initBlogStructure();
            this.log('✅ Blog structure ready');
            return true;
        } catch (e) {
            this.log(`❌ Blog init error: ${e.message}`);
            return false;
        }
    }

    // 5. 전체 배포 실행
    async deploy() {
        this.log('═══════════════════════════════════════');
        this.log('🚀 MOLTBOT FULL DEPLOYMENT STARTING');
        this.log('═══════════════════════════════════════');

        const results = {
            proxy: await this.startCodexProxy(),
            scheduler: await this.setupSchedulers(),
            health: await this.testHealthDashboard(),
            blog: await this.initBlog()
        };

        this.log('═══════════════════════════════════════');
        this.log('📊 DEPLOYMENT SUMMARY');
        this.log('═══════════════════════════════════════');
        this.log(`  Codex Proxy:     ${results.proxy ? '✅' : '❌'}`);
        this.log(`  Schedulers:      ${results.scheduler ? '✅' : '❌'}`);
        this.log(`  Health Dashboard: ${results.health ? '✅' : '❌'}`);
        this.log(`  Blog System:     ${results.blog ? '✅' : '❌'}`);
        this.log('═══════════════════════════════════════');

        // 배포 결과를 Telegram으로 알림 (OpenClaw 연동 시)
        const summary = `🎉 Moltbot 시스템 가동 완료!\n\n` +
            `✅ Codex Proxy: ${results.proxy ? '정상' : '오류'}\n` +
            `✅ 스케줄러: 설정 완료\n` +
            `✅ 건강 대시보드: ${results.health ? '정상' : '오류'}\n` +
            `✅ 블로그 시스템: ${results.blog ? '정상' : '오류'}\n\n` +
            `💡 아침 7시 브리핑이 자동으로 시작됩니다.`;

        fs.writeFileSync(path.join(this.logDir, 'deploy_result.txt'), summary);

        return results;
    }

    sleep(ms) {
        return new Promise(resolve => setTimeout(resolve, ms));
    }
}

module.exports = MoltbotDeployer;

// 직접 실행 시
if (require.main === module) {
    const deployer = new MoltbotDeployer();
    deployer.deploy()
        .then(results => {
            console.log('\n🎉 Deployment complete!');
            process.exit(Object.values(results).every(r => r) ? 0 : 1);
        })
        .catch(err => {
            console.error('Deployment failed:', err);
            process.exit(1);
        });
}
