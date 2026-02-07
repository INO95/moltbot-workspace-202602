/**
 * Google Sheets 데이터 정리 및 효율화 스크립트
 * - 빈 행/중복 행 제거
 * - 데이터 구조 최적화
 * - 숨긴 시트 데이터 통합
 */

const { GoogleSpreadsheet } = require('google-spreadsheet');
const { JWT } = require('google-auth-library');
const fs = require('fs');
const path = require('path');

const creds = require('../data/secure/google_creds.json');
const config = require('../data/config.json');

class SheetsOptimizer {
    constructor() {
        this.auth = new JWT({
            email: creds.client_email,
            key: creds.private_key,
            scopes: ['https://www.googleapis.com/auth/spreadsheets'],
        });
        this.doc = new GoogleSpreadsheet(config.spreadsheetId, this.auth);
    }

    async init() {
        await this.doc.loadInfo();
        console.log(`📄 Document: ${this.doc.title}`);
    }

    // 중복 및 빈 행 분석
    async analyzeSheet(sheetName) {
        const sheet = this.doc.sheetsByTitle[sheetName];
        if (!sheet) {
            console.log(`❌ Sheet not found: ${sheetName}`);
            return null;
        }

        const rows = await sheet.getRows();
        const analysis = {
            sheetName,
            totalRows: rows.length,
            emptyRows: [],
            duplicates: [],
            uniqueRows: []
        };

        const seen = new Map();

        for (let i = 0; i < rows.length; i++) {
            const row = rows[i];
            const values = sheet.headerValues.map(h => row.get(h) || '');
            const nonEmpty = values.filter(v => v.trim() !== '');

            // 빈 행 체크
            if (nonEmpty.length === 0) {
                analysis.emptyRows.push(i + 2); // 1-indexed + header
                continue;
            }

            // 중복 체크 (핵심 컬럼 기준)
            const key = values.join('|');
            if (seen.has(key)) {
                analysis.duplicates.push({
                    rowNum: i + 2,
                    originalRow: seen.get(key)
                });
            } else {
                seen.set(key, i + 2);
                analysis.uniqueRows.push(row);
            }
        }

        console.log(`\n📊 [${sheetName}] 분석 결과:`);
        console.log(`   전체: ${analysis.totalRows}행`);
        console.log(`   빈 행: ${analysis.emptyRows.length}개`);
        console.log(`   중복: ${analysis.duplicates.length}개`);
        console.log(`   유효: ${analysis.uniqueRows.length}개`);

        return analysis;
    }

    // 시트 정리 (빈 행/중복 제거)
    async cleanSheet(sheetName, dryRun = true) {
        const analysis = await this.analyzeSheet(sheetName);
        if (!analysis) return;

        if (dryRun) {
            console.log(`\n⚠️ DRY RUN: 실제 삭제 없음. dryRun=false로 실행하세요.`);
            return analysis;
        }

        const sheet = this.doc.sheetsByTitle[sheetName];
        const rows = await sheet.getRows();

        // 삭제할 인덱스 (뒤에서부터 삭제해야 인덱스 밀림 방지)
        const toDelete = [
            ...analysis.emptyRows,
            ...analysis.duplicates.map(d => d.rowNum)
        ].sort((a, b) => b - a);

        console.log(`\n🗑️ 삭제 예정: ${toDelete.length}행`);

        for (const rowNum of toDelete) {
            const rowIndex = rowNum - 2; // header 제외
            if (rows[rowIndex]) {
                await rows[rowIndex].delete();
                console.log(`   Deleted row ${rowNum}`);
            }
        }

        console.log(`✅ [${sheetName}] 정리 완료`);
        return analysis;
    }

    // 가계부 데이터 구조 최적화
    async optimizeFinanceSheet() {
        console.log('\n💰 가계부 최적화 시작...');

        // 현재 사용 중인 시트 분석
        const v2Sheet = this.doc.sheetsByTitle['가계부_V2'];
        if (!v2Sheet) {
            console.log('가계부_V2 시트를 찾을 수 없습니다.');
            return;
        }

        const rows = await v2Sheet.getRows();

        // 카테고리별 통계
        const byCategory = {};
        const byMonth = {};

        for (const row of rows) {
            const category = row.get('카테고리') || '기타';
            const amount = parseInt(row.get('금액 (엔)')) || 0;
            const date = row.get('날짜') || '';

            if (!byCategory[category]) byCategory[category] = 0;
            byCategory[category] += amount;

            const monthKey = date.slice(0, 5); // "YY MM"
            if (monthKey) {
                if (!byMonth[monthKey]) byMonth[monthKey] = { income: 0, expense: 0 };
                if (amount > 0) byMonth[monthKey].income += amount;
                else byMonth[monthKey].expense += Math.abs(amount);
            }
        }

        console.log('\n📊 카테고리별 요약:');
        for (const [cat, total] of Object.entries(byCategory).sort((a, b) => a[1] - b[1])) {
            console.log(`   ${cat}: ${total.toLocaleString()}엔`);
        }

        console.log('\n📊 월별 요약:');
        for (const [month, data] of Object.entries(byMonth).sort()) {
            console.log(`   ${month}: +${data.income.toLocaleString()} / -${data.expense.toLocaleString()}`);
        }

        return { byCategory, byMonth };
    }

    // 전체 최적화 실행
    async runFullOptimization() {
        await this.init();

        const sheets = ['가계부', '가계부_V2', '체크리스트_V2'];

        for (const sheetName of sheets) {
            await this.analyzeSheet(sheetName);
        }

        await this.optimizeFinanceSheet();

        console.log('\n✅ 분석 완료. 실제 정리를 원하면 cleanSheet(sheetName, false)를 호출하세요.');
    }
}

module.exports = SheetsOptimizer;

if (require.main === module) {
    const optimizer = new SheetsOptimizer();
    optimizer.runFullOptimization()
        .catch(err => console.error('Error:', err));
}
