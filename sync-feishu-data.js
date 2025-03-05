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
    const tokenRes = await axios.post('https://open.feishu.cn/open-apis/auth/v3/tenant_access_token/internal', {
      app_id: FEISHU_APP_ID,
      app_secret: FEISHU_APP_SECRET
    });
    const token = tokenRes.data.tenant_access_token;
    
    // 2. 获取各分类的食物数据
    const categories = ['随便', '饮品', '家常菜', '优惠'];
    const categoryIds = {
      '随便': 'all',
      '饮品': 'drinks',
      '家常菜': 'homeCooking',
      '优惠': 'deals'
    };
    
    let foodData = {};
    
    for (const category of categories) {
      console.log(`获取${category}分类数据...`);
      // 获取对应工作表的数据
      const encodedCategory = encodeURIComponent(category);
      const sheetRes = await axios.get(
        `https://open.feishu.cn/open-apis/sheets/v2/spreadsheets/${SHEET_TOKEN}/values/${encodedCategory}`,
        { headers: { 'Authorization': `Bearer ${token}` } }
      );
      
      const rows = sheetRes.data.data.values;
      // 假设第一行是表头
      const headers = rows[0];
      
      // 找到各列的索引
      const activeIndex = headers.findIndex(h => h.toLowerCase() === 'active');
      const nameIndex = headers.findIndex(h => h.toLowerCase() === 'name');
      const imageIndex = headers.findIndex(h => h.toLowerCase() === 'image');
      const descIndex = headers.findIndex(h => h.toLowerCase() === 'description');
      
      // 处理数据行
      const items = rows.slice(1)
        .filter(row => row[activeIndex]?.toUpperCase() === 'Y') // 只保留active=Y的行
        .map(row => {
          // 基本字段
          const item = {
            name: row[nameIndex],
            image: row[imageIndex],
            description: row[descIndex]
          };
          
          // 优惠类别额外字段
          if (category === '优惠') {
            const appIdIndex = headers.findIndex(h => h.toLowerCase() === 'appid');
            const pathIndex = headers.findIndex(h => h.toLowerCase() === 'path');
            const platformIndex = headers.findIndex(h => h.toLowerCase() === 'platform');
            
            if (appIdIndex >= 0) item.appId = row[appIdIndex];
            if (pathIndex >= 0) item.path = row[pathIndex];
            if (platformIndex >= 0) item.platform = row[platformIndex];
          }
          
          return item;
        });
      
      foodData[categoryIds[category]] = items;
    }
    
    // 3. 将数据保存为本地JSON文件
    const jsonData = JSON.stringify(foodData, null, 2);
    fs.writeFileSync('food-data.json', jsonData);
    console.log('数据已保存到本地文件');
    
    // 4. 上传到OSS
    console.log('开始上传到OSS...');
    
    // 上传带时间戳的版本
    const timestamp = new Date().toISOString().split('T')[0];
    await ossClient.put(`food-data/food-data-${timestamp}.json`, Buffer.from(jsonData));
    
    // 上传最新版本
    await ossClient.put('food-data/food-data-latest.json', Buffer.from(jsonData));
    
    console.log('数据已成功上传到OSS');
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
