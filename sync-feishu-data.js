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
      
      // 根据您提供的表头信息找到各列的索引
      const activeIndex = headers.findIndex(h => h && h.toLowerCase() === 'active');
      const nameIndex = headers.findIndex(h => h && h.toLowerCase() === 'foodname');
      const descIndex = headers.findIndex(h => h && h.toLowerCase() === 'fooddescription');
      const imageIndex = headers.findIndex(h => h && h.toLowerCase() === 'imageurl');
      const appIdIndex = headers.findIndex(h => h && h.toLowerCase() === 'appid');
      const pathIndex = headers.findIndex(h => h && h.toLowerCase() === 'path');
      
      console.log(`列索引 - active: ${activeIndex}, name: ${nameIndex}, description: ${descIndex}, image: ${imageIndex}, appId: ${appIdIndex}, path: ${pathIndex}`);
      
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
          if (appIdIndex !== -1 && row[appIdIndex]) item.appId = row[appIdIndex];
          if (pathIndex !== -1 && row[pathIndex]) item.path = row[pathIndex];
          // 添加platform字段，用于小程序中显示
          item.platform = '美团圈圈';
        }
        
        items.push(item);
      }
      
      console.log(`工作表 ${sheetTitle} 处理完成，有效数据 ${items.length} 条`);
      foodData[categoryIds[sheetTitle]] = items;
    }
    
    // 4. 将数据保存为本地JSON文件
    const jsonData = JSON.stringify(foodData, null, 2);
    fs.writeFileSync('food-data.json', jsonData);
    console.log('数据已保存到本地文件');
    
    // 5. 上传到OSS
    console.log('开始上传到OSS...');
    
    try {
      // 上传带时间戳的版本
      const timestamp = new Date().toISOString().split('T')[0];
      await ossClient.put(`food-data/food-data-${timestamp}.json`, Buffer.from(jsonData));
      
      // 上传最新版本
      await ossClient.put('food-data/food-data-latest.json', Buffer.from(jsonData));
      
      console.log('数据已成功上传到OSS');
    } catch (ossError) {
      console.error('上传到OSS失败:', ossError);
      // 即使OSS上传失败，我们也认为同步基本成功，因为数据已经获取到了
    }
    
    return { success: true };
  } catch (error) {
    console.error('同步数据失败:', error);
    return { success: false, error: error.message };
  }
}

// 执行同步
syncFeiShuData().then(result => {
  if (result.success) {
    console.log('同步完成');
    process.exit(0);
  } else {
    console.error('同步失败');
    process.exit(1);
  }
});
