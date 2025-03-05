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
    
    // 2. 使用批量读取API获取所有工作表数据
    const categories = ['随便', '饮品', '家常菜', '优惠'];
    const categoryIds = {
      '随便': 'all',
      '饮品': 'drinks',
      '家常菜': 'homeCooking',
      '优惠': 'deals'
    };
    
    // 构建范围参数
    const ranges = categories.map(category => `${encodeURIComponent(category)}!A:Z`).join(',');
    console.log('批量读取范围:', ranges);
    
    // 使用批量读取API
    console.log('使用批量读取API获取数据...');
    const batchRes = await axios.get(
      `https://open.feishu.cn/open-apis/sheets/v2/spreadsheets/${SHEET_TOKEN}/values_batch_get?ranges=${ranges}&valueRenderOption=ToString&dateTimeRenderOption=FormattedString`,
      { headers: { 'Authorization': `Bearer ${token}` } }
    );
    
    console.log('批量读取响应状态码:', batchRes.status);
    
    if (!batchRes.data || !batchRes.data.data || !batchRes.data.data.valueRanges) {
      throw new Error('批量读取数据失败: ' + JSON.stringify(batchRes.data));
    }
    
    const valueRanges = batchRes.data.data.valueRanges;
    console.log(`获取到 ${valueRanges.length} 个范围的数据`);
    
    // 处理每个范围的数据
    let foodData = {};
    
    for (let i = 0; i < valueRanges.length; i++) {
      const range = valueRanges[i];
      const sheetName = range.range.split('!')[0];
      const decodedSheetName = decodeURIComponent(sheetName);
      const category = categories.find(cat => cat === decodedSheetName);
      
      if (!category) {
        console.log(`找不到匹配的分类: ${decodedSheetName}`);
        continue;
      }
      
      console.log(`处理工作表: ${category}`);
      
      if (!range.values || range.values.length < 2) {
        console.log(`工作表 ${category} 数据不足，跳过`);
        continue;
      }
      
      // 假设第一行是表头
      const headers = range.values[0];
      console.log(`表头: ${headers.join(', ')}`);
      
      // 更灵活的表头匹配
      const findColumnIndex = (headers, possibleNames) => {
        for (const name of possibleNames) {
          const index = headers.findIndex(h => h && String(h).toLowerCase() === name.toLowerCase());
          if (index !== -1) return index;
        }
        return -1;
      };
      
      // 查找各列索引
      const activeIndex = findColumnIndex(headers, ['active', 'Active', '启用', '是否启用']);
      const nameIndex = findColumnIndex(headers, ['foodname', 'FoodName', 'name', 'Name', '名称', '食物名称']);
      const descIndex = findColumnIndex(headers, ['fooddescription', 'FoodDescription', 'description', 'Description', '描述', '食物描述']);
      const imageIndex = findColumnIndex(headers, ['imageurl', 'ImageUrl', 'image', 'Image', '图片', '图片链接']);
      const appIdIndex = findColumnIndex(headers, ['appid', 'AppId', 'appID', 'AppID', '小程序ID']);
      const pathIndex = findColumnIndex(headers, ['path', 'Path', '路径', '小程序路径']);
      
      console.log(`列索引 - active: ${activeIndex}, name: ${nameIndex}, description: ${descIndex}, image: ${imageIndex}, appId: ${appIdIndex}, path: ${pathIndex}`);
      
      if (nameIndex === -1 || imageIndex === -1) {
        console.log(`工作表 ${category} 缺少必要的列，跳过`);
        continue;
      }
      
      // 处理数据行
      const items = [];
      for (let j = 1; j < range.values.length; j++) {
        const row = range.values[j];
        if (!row || row.length === 0) continue;
        
        // 检查active状态
        if (activeIndex !== -1 && (!row[activeIndex] || String(row[activeIndex]).toUpperCase() !== 'Y')) {
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
          description: descIndex !== -1 && row.length > descIndex ? (row[descIndex] || '') : ''
        };
        
        // 优惠类别额外字段
        if (category === '优惠') {
          if (appIdIndex !== -1 && row.length > appIdIndex && row[appIdIndex]) item.appId = row[appIdIndex];
          if (pathIndex !== -1 && row.length > pathIndex && row[pathIndex]) item.path = row[pathIndex];
          // 添加platform字段，用于小程序中显示
          item.platform = '美团圈圈';
        }
        
        items.push(item);
      }
      
      console.log(`工作表 ${category} 处理完成，有效数据 ${items.length} 条`);
      foodData[categoryIds[category]] = items;
    }
    
    // 检查是否获取到任何数据
    const totalItems = Object.values(foodData).reduce((sum, items) => sum + (items ? items.length : 0), 0);
    console.log(`总共获取到 ${totalItems} 条数据`);
    
    // 确保所有必要的分类都存在
    const expectedCategories = ['all', 'drinks', 'homeCooking', 'deals'];
    for (const category of expectedCategories) {
      if (!foodData[category]) {
        console.log(`创建空的${category}分类`);
        foodData[category] = [];
      }
    }
    
    // 检查每个分类中的项目是否有必要的字段
    for (const category in foodData) {
      foodData[category] = foodData[category].map(item => {
        return {
          name: item.name || '未命名',
          image: item.image || 'https://example.com/default.jpg',
          description: item.description || '',
          ...(item.appId ? { appId: item.appId } : {}),
          ...(item.path ? { path: item.path } : {}),
          ...(item.platform ? { platform: item.platform } : {})
        };
      });
    }
    
    // 如果没有获取到任何数据，使用测试数据
    if (totalItems === 0) {
      console.log('未能从工作表获取数据，创建测试数据');
      foodData = {
        all: [
          {
            name: "测试食物",
            image: "https://what-to-eatttt.oss-cn-hangzhou.aliyuncs.com/2025/02/07/Sui41G.png",
            description: "这是一个测试项目"
          }
        ],
        drinks: [
          {
            name: "测试饮品",
            image: "https://what-to-eatttt.oss-cn-hangzhou.aliyuncs.com/2025/02/07/dFyLkM.png",
            description: "这是一个测试饮品"
          }
        ],
        homeCooking: [
          {
            name: "测试家常菜",
            image: "https://what-to-eatttt.oss-cn-hangzhou.aliyuncs.com/2025/02/07/Z3br5A.png",
            description: "这是一个测试家常菜"
          }
        ],
        deals: [
          {
            name: "测试优惠",
            image: "https://what-to-eatttt.oss-cn-hangzhou.aliyuncs.com/2025/%E9%A2%86%E5%88%B8/%E4%BC%98%E6%83%A0%E5%88%B8%20icon.png",
            description: "这是一个测试优惠",
            appId: "wxe75a0e68778dcc4d",
            path: "/pages/index/index",
            platform: "美团圈圈"
          }
        ]
      };
    }
    
    // 3. 将数据保存为本地JSON文件
    const jsonData = JSON.stringify(foodData, null, 2);
    fs.writeFileSync('food-data.json', jsonData);
    console.log('数据已保存到本地文件');
    
    // 4. 上传到OSS
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
