const axios = require('axios');
const OSS = require('ali-oss');
const fs = require('fs');

// 从环境变量获取配置
const FEISHU_APP_ID = process.env.FEISHU_APP_ID;
const FEISHU_APP_SECRET = process.env.FEISHU_APP_SECRET;
const SHEET_TOKEN = process.env.SHEET_TOKEN;

// 阿里云OSS配置
const ossClient = new OSS({
  region: process.env.OSS_REGION,
  accessKeyId: process.env.OSS_ACCESS_KEY_ID,
  accessKeySecret: process.env.OSS_ACCESS_KEY_SECRET,
  bucket: process.env.OSS_BUCKET,
});

async function syncFeiShuData() {
  try {
    console.log('开始同步飞书数据...');
    
    // 1. 获取飞书访问令牌
    console.log('获取飞书访问令牌...');
    const tokenRes = await axios.post('https://open.feishu.cn/open-apis/auth/v3/tenant_access_token/internal', {
      app_id: FEISHU_APP_ID,
      app_secret: FEISHU_APP_SECRET
    });
    
    if (!tokenRes.data || !tokenRes.data.tenant_access_token) {
      throw new Error('获取飞书访问令牌失败: ' + JSON.stringify(tokenRes.data));
    }
    
    const token = tokenRes.data.tenant_access_token;
    console.log('成功获取访问令牌');
    
    // 2. 获取表格中的所有工作表
    console.log('获取表格信息...');
    const sheetsRes = await axios.get(
      `https://open.feishu.cn/open-apis/sheets/v2/spreadsheets/${SHEET_TOKEN}/sheets`,
      { headers: { 'Authorization': `Bearer ${token}` } }
    );
    
    console.log('表格API响应:', JSON.stringify(sheetsRes.data, null, 2));
    
    if (!sheetsRes.data || !sheetsRes.data.data || !sheetsRes.data.data.sheets) {
      throw new Error('获取表格信息失败: ' + JSON.stringify(sheetsRes.data));
    }
    
    const sheets = sheetsRes.data.data.sheets;
    console.log(`找到 ${sheets.length} 个工作表`);
    
    // 3. 处理每个工作表
    const categoryIds = {
      '随便': 'all',
      '饮品': 'drinks',
      '家常菜': 'homeCooking',
      '优惠': 'deals'
    };
    
    let foodData = {};
    
    for (const sheet of sheets) {
      const sheetTitle = sheet.sheet_name;
      const sheetId = sheet.sheet_id;
      
      // 只处理我们关心的工作表
      if (!Object.keys(categoryIds).includes(sheetTitle)) {
        console.log(`跳过工作表: ${sheetTitle}`);
        continue;
      }
      
      console.log(`处理工作表: ${sheetTitle} (ID: ${sheetId})`);
      
      // 获取工作表数据
      const dataRes = await axios.get(
        `https://open.feishu.cn/open-apis/sheets/v2/spreadsheets/${SHEET_TOKEN}/values/${sheetId}`,
        { headers: { 'Authorization': `Bearer ${token}` } }
      );
      
      console.log(`工作表 ${sheetTitle} 数据响应:`, JSON.stringify(dataRes.data, null, 2));
      
      if (!dataRes.data || !dataRes.data.data || !dataRes.data.data.values) {
        console.log(`工作表 ${sheetTitle} 没有数据，跳过`);
        continue;
      }
      
      const rows = dataRes.data.data.values;
      if (rows.length < 2) {
        console.log(`工作表 ${sheetTitle} 数据不足，跳过`);
        continue;
      }
      
      // 假设第一行是表头
      const headers = rows[0];
      console.log(`表头: ${headers.join(', ')}`);
      
      // 找到各列的索引
      const nameIndex = headers.findIndex(h => h && h.toLowerCase() === 'name');
      const imageIndex = headers.findIndex(h => h && h.toLowerCase() === 'image');
      const descIndex = headers.findIndex(h => h && h.toLowerCase() === 'description');
      const activeIndex = headers.findIndex(h => h && h.toLowerCase() === 'active');
      
      console.log(`列索引 - name: ${nameIndex}, image: ${imageIndex}, description: ${descIndex}, active: ${activeIndex}`);
      
      if (nameIndex === -1 || imageIndex === -1 || descIndex === -1) {
        console.log(`工作表 ${sheetTitle} 缺少必要的列，跳过`);
        continue;
      }
      
      // 处理数据行
      const items = [];
      for (let i = 1; i < rows.length; i++) {
        const row = rows[i];
        if (!row || row.length === 0) continue;
        
        // 检查active状态
        if (activeIndex !== -1 && (!row[activeIndex] || row[activeIndex].toUpperCase() !== 'Y')) {
          continue;
        }
        
        // 确保必要字段存在
        if (!row[nameIndex] || !row[imageIndex]) {
          continue;
        }
        
        // 基本字段
        const item = {
          name: row[nameIndex],
          image: row[imageIndex],
          description: row[descIndex] || ''
        };
        
        // 优惠类别额外字段
        if (sheetTitle === '优惠') {
          const appIdIndex = headers.findIndex(h => h && h.toLowerCase() === 'appid');
          const pathIndex = headers.findIndex(h => h && h.toLowerCase() === 'path');
          const platformIndex = headers.findIndex(h => h && h.toLowerCase() === 'platform');
          
          if (appIdIndex !== -1 && row
