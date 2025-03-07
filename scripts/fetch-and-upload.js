const axios = require('axios');
const OSS = require('ali-oss');

async function main() {
  try {
    console.log('开始同步飞书数据到阿里云OSS...');
    
    // 1. 获取飞书访问令牌
    console.log('获取飞书访问令牌...');
    const tokenResponse = await axios.post('https://open.feishu.cn/open-apis/auth/v3/tenant_access_token/internal', {
      app_id: process.env.FEISHU_APP_ID,
      app_secret: process.env.FEISHU_APP_SECRET
    });
    
    if (!tokenResponse.data.tenant_access_token) {
      throw new Error('获取飞书访问令牌失败: ' + JSON.stringify(tokenResponse.data));
    }
    
    const token = tokenResponse.data.tenant_access_token;
    console.log('成功获取飞书访问令牌');
    
    // 2. 获取表格数据
    console.log('获取飞书表格数据...');
    const tableResponse = await axios.get(
      `https://open.feishu.cn/open-apis/sheets/v2/spreadsheets/${process.env.SPREADSHEET_ID}/values/${process.env.SHEET_NAME}`, 
      {
        headers: {
          'Authorization': `Bearer ${token}`
        }
      }
    );
    
    if (!tableResponse.data.data || !tableResponse.data.data.valueRange || !tableResponse.data.data.valueRange.values) {
      throw new Error('获取表格数据失败: ' + JSON.stringify(tableResponse.data));
    }
    
    // 3. 处理表格数据
    console.log('处理表格数据...');
    const rawData = tableResponse.data.data.valueRange.values;
    const headers = rawData[0];
    
    // 找到各字段的索引
    const categoryIndex = headers.indexOf('category');
    const idIndex = headers.indexOf('id');
    const nameIndex = headers.indexOf('name');
    const imageIndex = headers.indexOf('image');
    const descriptionIndex = headers.indexOf('description');
    const priceIndex = headers.indexOf('price');
    
    // 检查必要字段是否存在
    if (categoryIndex === -1 || nameIndex === -1 || imageIndex === -1 || descriptionIndex === -1) {
      throw new Error('表格缺少必要字段，请检查表头');
    }
    
    // 处理数据，按分类组织
    const processedData = {};
    
    for (let i = 1; i < rawData.length; i++) {
      const row = rawData[i];
      // 跳过空行
      if (!row[categoryIndex] || !row[nameIndex]) continue;
      
      const category = row[categoryIndex];
      
      // 如果是新分类，初始化数组
      if (!processedData[category]) {
        processedData[category] = [];
      }
      
      // 添加数据项
      processedData[category].push({
        id: row[idIndex] || `item-${i}`,
        name: row[nameIndex],
        image: row[imageIndex] || '',
        description: row[descriptionIndex] || '',
        price: priceIndex !== -1 ? row[priceIndex] || null : null
      });
    }
    
    console.log(`成功处理 ${rawData.length - 1} 行数据，共 ${Object.keys(processedData).length} 个分类`);
    
    // 4. 准备JSON数据
    const jsonData = JSON.stringify({
      categories: processedData,
      updateTime: new Date().toISOString()
    }, null, 2);
    
    // 5. 上传到阿里云OSS
    console.log('上传数据到阿里云OSS...');
    const client = new OSS({
      region: process.env.OSS_REGION,
      accessKeyId: process.env.OSS_ACCESS_KEY_ID,
      accessKeySecret: process.env.OSS_ACCESS_KEY_SECRET,
      bucket: process.env.OSS_BUCKET,
    });
    
    // 上传JSON文件
    const result = await client.put('food-data.json', Buffer.from(jsonData));
    console.log('上传成功，文件URL:', result.url);
    
    // 设置文件为公共可读，并设置正确的Content-Type
    await client.putACL('food-data.json', 'public-read');
    await client.putMeta('food-data.json', {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'max-age=3600' // 1小时缓存
    });
    
    console.log('同步完成！');
  } catch (error) {
    console.error('同步过程中出错:', error);
    process.exit(1);
  }
}

main();
