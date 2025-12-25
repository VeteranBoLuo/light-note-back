import pool from '../db/index.js';
import { resultData, snakeCaseKeys, mergeExistingProperties } from '../util/common.js';
import request from '../http/request.js';
import { fetchWithTimeout, validateQueryParams } from '../util/request.js';
import nodeMail from '../util/nodemailer.js';
let redisClient;
if (process.platform === 'linux') {
  redisClient = (await import('../util/redisClient.js')).default;
}

export const login = (req, res) => {
  try {
    const { email, password } = req.body;
    const sql = 'SELECT * FROM user WHERE email = ? AND password = ?';
    pool
      .query(sql, [email, password])
      .then(async ([result]) => {
        if (result.length === 0) {
          res.send(resultData(null, 401, '邮箱或密码错误或已过期，请重新输入')); // 设置状态码为401
          return;
        }
        if (result[0].del_flag === 1) {
          res.send(resultData(null, 401, '账号已被禁用')); // 设置状态码为401
          return;
        }
        const bookmarkTotalSql = `SELECT COUNT(*) FROM bookmark WHERE user_id=? and del_flag = 0`;
        const [bookmarkTotalRes] = await pool.query(bookmarkTotalSql, [result[0].id]);
        const tagTotalSql = `SELECT COUNT(*) FROM tag WHERE user_id=? and del_flag = 0`;
        const [tagTotalRes] = await pool.query(tagTotalSql, [result[0].id]);
        const noteTotalSql = `SELECT COUNT(*) FROM note WHERE create_by=? and del_flag = 0`;
        const [noteTotalRes] = await pool.query(noteTotalSql, [result[0].id]);
        result[0].bookmarkTotal = bookmarkTotalRes[0]['COUNT(*)'];
        result[0].tagTotal = tagTotalRes[0]['COUNT(*)'];
        result[0].noteTotal = noteTotalRes[0]['COUNT(*)'];
        res.send(resultData(result[0]));
      })
      .catch((err) => {
        res.send(resultData(null, 500, '服务器内部错误: ' + err.message)); // 设置状态码为500
      });
  } catch (e) {
    res.send(resultData(null, 400, '客户端请求异常：' + e)); // 设置状态码为400
  }
};

export const registerUser = (req, res) => {
  try {
    pool
      .query('SELECT * FROM user WHERE email = ?', [req.body.email])
      .then(([result]) => {
        if (result?.length > 0) {
          res.send(resultData(null, 500, '账号已存在')); // 设置状态码为500
        } else {
          const params = req.body;
          params.createTime = req.requestTime;
          params.theme = 'day';
          pool
            .query('INSERT INTO user set ?', [snakeCaseKeys(params)])
            .then(async () => {
              const [userRes] = await pool.query('SELECT * FROM USER WHERE email=?', [req.body.email]);
              const userId = userRes[0].id;
              const bookmarkData = {
                name: 'iconify',
                userId: userId,
                url: 'https://icon-sets.iconify.design/',
                description: '全球最大的免费图标网站之一',
                iconUrl:
                  'data:image/vnd.microsoft.icon;base64,AAABAAUAEBAAAAEAIABoBAAAVgAAABgYAAABACAAiAkAAL4EAAAgIAAAAQAgAKgQAABGDgAAMDAAAAEAIACoJQAA7h4AAEBAAAABACAAKEIAAJZEAAAoAAAAEAAAACAAAAABACAAAAAAAAAEAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAACTcy0AlHQvB5BwKUiTdC6lm34+4aGGSfmhhkn5m34+4ZN0LqWQcClIlHQvB5NzLQAAAAAAAAAAAJd9NwCScisAknIrFpN0L46mjVTtyruZ/+XdzP/w7OL/8Ozi/+XdzP/Ku5n/po1T7ZN0L46ScisWknIrAJd9NwCUdS8AknMrFpZ3M6u7p3v+8Ozi///////9/fv/9vPu//bz7f/9/Pv///////Ds4v+7p3v+lnczq5JzKxaUdS8AlHQvBpN0L467qHz++ffy//39+//e1cD/tqBx/6OJTf+jiE3/tJ9v/9vQuf/7+vj/+ffy/7uofP6TdC+OlHQvBpBwKUimjVTs8Ovi//38+//MvZv/qI9W/7eidP/FtI//xbSP/7ijdf+njlX/wa+H//j18f/w7OL/po1U7JBwKUiTdC6lyruZ///////v6uD/zsCg/+/r4P/+/fz////////////+/f3/8u7l/9DCo//i2sf//////8q7mf+TdC6lm34+4OTdy////////v39//7+/f/////////////////////////////////+/v7//fz7///////k3cv/m34+4KGGSfnv6+H/////////////////////////////////////////////////////////////////7+vh/6GGSfmhhkn57+vh////////////7efb/9rPt//8+/n////////////8+/n/2s+3/+3n2////////////+/r4f+hhkn5m34+4OTdy////////////8q6mP+fhEb/8/Do////////////8/Do/5+ERv/Kupj////////////k3cv/m34+4JN0LqXKu5n////////////Xy7H/tJ5t//f18P////////////f18P+0nm3/18ux////////////yruZ/5N0LqWQcClIpo1U7PDr4f///////Pv5//j28v//////////////////////+Pby//z7+f//////8Ovh/6aNVOyQcClIlHQvBpN0L467qHz++Pby////////////////////////////////////////////+Pby/7uofP6TdC+OlHQvBpR1LwCScysWlnczq7une/7w7OL/////////////////////////////////8Ozi/7une/6WdzOrknMrFpR1LwCXfTcAknIrAJJyKxaTdC+Opo1U7cq7mf/l3cz/7+vh/+/r4f/l3cz/yruZ/6aNVO2TdC+OknIrFpJyKwCXfTcAAAAAAAAAAACTcy0AlHQvB5BwKUiTdC6lm34+4aGGSfmhhkn5m34+4ZN0LqWQcClIlHQvB5NzLQAAAAAAAAAAAOAHAADAAwAAgAEAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAACAAQAAwAMAAOAHAAAoAAAAGAAAADAAAAABACAAAAAAAAAJAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAACWdjEAlnYyCJR1MTqTdC6IknMsxZJzLOiScyz6knMs+pJzLOiScyzFk3QuiJR1MTqWdjIIlnYxAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAmHYyAJt4NQGVdjExk3QunZN0L+edgEH+rpZi/76sgv/Ht5L/x7eS/76sgv+ulmL/nYBB/pN0L+eTdC6dlXYxMZt4NQGYdjIAAAAAAAAAAAAAAAAAAAAAAAAAAACVdjAAlXcxBZR1MFuTdC7dn4NF/8W0jv/p49X/+vj1//7+/f////////////7+/f/6+PX/6ePV/8W0jv+fg0X/k3Qu3ZR1MFuVdzEFlXYwAAAAAAAAAAAAAAAAAJV3MQCWeTIElHUwcpR1MO+ynGr/6eLU//7+/f////////////////////////////////////////////7+/f/p4tT/spxq/5R1MO+UdTBylnkyBJV3MQAAAAAAl3YyAG9kFQCUdTBblHUw77uofP/18uv////////////+/v3/8u3l/9zSu//OwKH/zsCh/9zRuv/w7OP//v38////////////9fLr/7uofP+UdTDvlHUwW29kFQCXdjIAlHUwAJV2MTGTdC7cspxq//Xx6/////////////Pw6P/IuZX/o4lN/5V3Mv+Sciz/knIr/5V2Mv+ih0r/w7KL/+7p3/////////////Xx6/+ynGr/k3Qu3JV2MTGUdTAAl3czB5N0Lpyfg0b/6OLT////////////6uTX/62VYP+VdjH/nYFB/6qRWv+wmWb/sJlm/6qRW/+egkP/lHYx/6SKT//d073//v7+///////o4tP/n4NG/5N0LpyXdzMHlHUxOpN0L+fFtI7//v79///////x7eT/rZZh/6uTXf/Txqn/7Ofb//f18P/8+/j//Pv4//f18P/t6N3/1sqv/7Gbaf+ih0r/3dO9///////+/v3/xbSO/5N0L+eUdTE6k3QuiJ2AQf7p49X////////////n4ND/0cOl//bz7v////////////////////////////////////////////r49P/az7f/08Wp//7+/f//////6ePU/52AQf6TdC6IknMsxa6WYv/5+PT////////////+/v7////+/////////////////////////////////////////////////////////////v79////////////+fj0/66WYv+ScyzFknMs6L6sgv/+/v7//////////////////////////////////////////////////////////////////////////////////////////////////v7+/76sgv+ScyzoknMs+se3kv///////////////////////////////////////////////////////////////////////////////////////////////////////////8e3kv+Scyz6knMs+se3kv///////////////////////f38/+vl1//w6+L/////////////////////////////////8Ovi/+vl1//9/fz//////////////////////8e3kv+Scyz6knMs6L6sgv/+/v7/////////////////6uTX/6CFSP+vmGT/+PXx///////////////////////49fH/r5hk/6CFSP/q5Nf//////////////////v7+/76sgv+ScyzoknMsxa6WYv/6+PT/////////////////4NfE/5R1MP+fhEb/8+/n///////////////////////z7+f/n4RG/5R1MP/g18T/////////////////+fj0/66WYv+ScyzFk3QuiJ2AQf7p49X/////////////////5t7O/5h7OP+mjFP/9fPs///////////////////////18+z/poxT/5h7OP/m3s7/////////////////6ePU/52AQf6TdC6IlHUxOpN0L+fFtI7//v79////////////+vn2/9jMs//h2MT//v79///////////////////////+/v3/4djE/9jMs//6+fb////////////+/v3/xbSO/5N0L+eUdTE6l3czB5N0Lpyfg0b/6OLT///////////////////////////////////////////////////////////////////////////////////////o4tP/n4NG/5N0LpyXdzMHlHUwAJV2MTGTdC7cspxq//Xx6/////////////////////////////////////////////////////////////////////////////Xx6/+ynGr/k3Qu3JV2MTGUdTAAl3YyAG9kFQCUdTBblHUw77uofP/18uv/////////////////////////////////////////////////////////////////9fLr/7uofP+UdTDvlHUwW29kFQCXdjIAAAAAAJV3MQCWeTIElHUwcpR1MO+ynGr/6eLU//7+/f////////////////////////////////////////////7+/f/p4tT/spxq/5R1MO+UdTBylnkyBJV3MQAAAAAAAAAAAAAAAACVdjAAlXcxBZR1MFuTdC7dn4NF/8W0jv/p49X/+vj0//7+/f////////////7+/f/6+PX/6ePV/8W0jv+fg0X/k3Qu3ZR1MFuVdzEFlXYwAAAAAAAAAAAAAAAAAAAAAAAAAAAAmHYyAJt4NQGVdjExk3QunZN0L+edgEH+rpZi/76sgv/Ht5L/x7eS/76sgv+ulmL/nYBB/pN0L+eTdC6dlXYxMZt4NQGYdjIAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAACWdjEAlnYyCJR1MTqTdC6IknMsxZJzLOiScyz6knMs+pJzLOiScyzFk3QuiJR1MTqWdjIIlnYxAAAAAAAAAAAAAAAAAAAAAAAAAAAA/AA/APAADwDgAAcAwAADAMAAAwCAAAEAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAgAABAMAAAwDAAAMA4AAHAPAADwD8AD8AKAAAACAAAABAAAAAAQAgAAAAAAAAEAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAlXYxAJV2MgaUdjEqlHYxa5V1MKWUdC/Pk3Qv7JN0LvmTdC75k3Qv7JR0L8+VdTCllHYxa5R2MSqVdjIGlXYxAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAlng0AJd4NQWVdjI4lHUwlJN0L9uTcy34lHUw/5l7Ov+dgUH/n4NF/5+DRf+dgUH/mXs6/5R1MP+Tcy34k3Qv25R1MJSVdjI4l3g1BZZ4NAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAnH87AJJyLQCWdjEZlHUxhpR0L+WTdC7/nYBA/7Sebv/Nv57/4NbC/+zm2f/y7eX/8u3l/+zm2f/g1sL/zb+e/7Sebv+cgED/k3Qu/5R0L+WUdTGGlnYxGZJyLQCcfzsAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAJV4MACJYTcAlHYxLpR1MLWTdC78m349/7yoff/m3s7/+vn2////////////////////////////////////////////+vn2/+bezv+8qH3/m349/5N0LvyUdTC1lHYxLolhNwCVeDAAAAAAAAAAAAAAAAAAAAAAAAAAAACXfDMAjGUpAJV3MT+UdTDOk3Qv/6uSXP/g1sL/+/r4//////////////////////////////////////////////////////////////////v6+P/g1sL/q5Jc/5N0L/+UdTDOlXcxP4xlKQCXfDMAAAAAAAAAAAAAAAAAm386AJN0LgCUdjEtlHUwzpV2Mf+2oXH/7une/////////////////////////////f38//j28v/18uv/9fLr//j28f/9/fz////////////////////////////u6d7/tqFx/5V2Mf+UdTDOlHYxLZN0LgCbfzoAAAAAAAAAAACVdjEAlnYxGpR1MLSTdC//tqFx//Xy6///////////////////////+Pby/97Vv//CsIj/rpZi/6WKUP+kilD/rpZi/8Guhv/c0br/9vTu///////////////////////18uv/tqFx/5N0L/+UdTC0lnYxGpV2MQAAAAAAlnczAJh5NgSUdTGGk3Qu/auSXP/u6d7//////////////////f37/+LZxv+znWz/mXs5/5JzLP+Scyz/knMt/5JzLf+Scyz/knMs/5h6N/+ulmL/2c61//r59v/////////////////u6d7/q5Jc/5N0Lv2UdTGGmHk2BJZ3MwCVdjEAlXYyOJR0L+Sbfj3/39bC//////////////////v59v/PwKH/nYBB/5FyK/+TdC7/mXs5/52AQf+fg0X/n4NF/52AQf+ZfDr/k3Qv/5FxK/+Yejf/vquB//Lv5v/////////////////f1sL/m349/5R0L+SVdjI4lXYxAJZ2MwWUdTCUk3Qu/7yoff/8+vj////////////9/Pr/y7yb/5d4Nf+ZfDr/sZto/8y9nP/f1cH/6+XX//Ds4//w7OP/6+XX/9/Wwv/Nv5//tJ9u/5yAQP+TdC7/sptp//Ds4/////////////z6+P+8qH3/k3Qu/5R1MJSWdjMFlHYxKpN0L9qdgED/5t7O/////////////////+DXw/+fg0X/tZ9w/+HYxf/59/P////////////////////////////////////////////6+fb/5+DR/8Gvhv+dgUL/uqZ6//v59////////////+bezv+cgED/k3Qv2pR2MSqUdjFrk3Mt97Sebv/6+fX/////////////////4dnF/9fLsf/59/P//////////////////////////////////////////////////////////////////Pz6/+bezf/Nvp7/+Pbx////////////+vn1/7Sebv+Tcy33lHYxa5V1MKWUdTD/zb6e/////////////////////////v7///////////////////////////////////////////////////////////////////////////////////////7+/v//////////////////////zb6e/5R1MP+VdTCllHQvz5l7Ov/f1sL////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////f1sL/mXs6/5R0L8+TdC/snYFB/+zm2f///////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////+zm2f+dgUH/k3Qv7JN0Lvmfg0X/8u3l////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////8u3l/5+DRf+TdC75k3Qu+Z+DRf/y7eX//////////////////////////////////Pv5//bz7f/8+/n////////////////////////////////////////////8+/n/9vPt//z7+f/////////////////////////////////y7eX/n4NF/5N0LvmTdC/snYFB/+zm2f////////////////////////////z8+v/Ku5n/pYtR/8q7mf/8/Pr//////////////////////////////////Pz6/8q7mf+li1H/yruZ//z8+v///////////////////////////+zm2f+dgUH/k3Qv7JR0L8+Zezr/39bC////////////////////////////9PHr/6KITP+RcSr/oohM//Tx6//////////////////////////////////08ev/oohM/5FxKv+iiEz/9PHr////////////////////////////39bC/5l7Ov+UdC/PlXUwpZR1MP/Nv57////////////////////////////z8Oj/n4RG/5JzLf+fhEb/8/Do//////////////////////////////////Pw6P+fhEb/knMt/5+ERv/z8Oj////////////////////////////Nvp7/lHUw/5V1MKWUdjFrk3Mt97Sebv/6+fX///////////////////////Tx6/+iiEz/kXEq/6KITP/08ev/////////////////////////////////9PHr/6KITP+RcSr/oohM//Tx6///////////////////////+vn1/7Sebv+Tcy33lHYxa5R2MSqTdC/anYBA/+bezv///////////////////////Pz6/8q7mf+li1H/yruZ//z8+v/////////////////////////////////8/Pr/yruZ/6WLUf/Ku5n//Pz6///////////////////////m3s7/nIBA/5N0L9qUdjEqlnYzBZR1MJSTdC7/vKh9//z6+P///////////////////////Pv5//bz7f/8+/n////////////////////////////////////////////8+/n/9vPt//z7+f///////////////////////Pr4/7yoff+TdC7/lHUwlJZ2MwWVdjEAlXYyOJR0L+Sbfj3/39bC///////////////////////////////////////////////////////////////////////////////////////////////////////////////////////f1sL/m349/5R0L+SVdjI4lXYxAJZ3MwCYeTYElHUxhpN0Lv2rklz/7une////////////////////////////////////////////////////////////////////////////////////////////////////////////7une/6uSXP+TdC79lHUxhph5NgSWdzMAAAAAAJV2MQCWdjEalHUwtJN0L/+2oXH/9fLr//////////////////////////////////////////////////////////////////////////////////////////////////Xy6/+2oXH/k3Qv/5R1MLSWdjEalXYxAAAAAAAAAAAAm386AJN0LgCUdjEtlHUwzpV2Mf+2oXH/7une///////////////////////////////////////////////////////////////////////////////////////u6d7/tqFx/5V2Mf+UdTDOlHYxLZN0LgCbfzoAAAAAAAAAAAAAAAAAl3wzAIxlKQCVdzE/lHUwzpN0L/+rklz/4NbC//v6+P//////////////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AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAl3k0O5V1MOmUdTD/lHUw/5R1MP+UdTD/lHUw/5h6OP/Ht5P/+PXw////////////////////////////////////////////////////////////////////////////////////////////////////////////9/Xv/8e3k/+Yejj/lHUw/5R1MP+UdTD/lHUw/5R1MP+VdTDpl3k0OwAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAACZdzMelHUwxJR1MP+UdTD/lHUw/5R1MP+UdTD/lHUw/5d4Nf+2oHH/3NK7//n38/////////////////////////////////////////////////////////////////////////////n38//c0rv/tqBx/5d4Nf+UdTD/lHUw/5R1MP+UdTD/lHUw/5R1MP+UdTDEmXczHgAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAP///wGWdjJhlHYx6pR1MP+UdTD/lHUw/5R1MP+UdTD/lHUw/5R1MP+WdzP/q5Jc/8Szjf/Vya7/5t7O//Lu5v/49fD//fz7//38+//49fD/8u7m/+bezv/Vya7/xLON/6uSXP+WdzP/lHUw/5R1MP+UdTD/lHUw/5R1MP+UdTD/lHUw/5R2MeqWdjJh////AQAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAJ+AQBCVdjKAlXYw7pR1MP+UdTD/lHUw/5R1MP+UdTD/lHUw/5R1MP+UdTD/lHUw/5R1MP+UdTD/lHUw/5R1MP+UdTD/lHUw/5R1MP+UdTD/lHUw/5R1MP+UdTD/lHUw/5R1MP+UdTD/lHUw/5R1MP+UdTD/lHUw/5R1MP+UdTD/lXYw7pV2MoCfgEAQAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAJ12Ow2VdjFzlHUx1ZR1MP+UdTD/lHUw/5R1MP+UdTD/lHUw/5R1MP+UdTD/lHUw/5R1MP+UdTD/lHUw/5R1MP+UdTD/lHUw/5R1MP+UdTD/lHUw/5R1MP+UdTD/lHUw/5R1MP+UdTHVlXYxc512Ow0AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAACWeDIzlHYxjZR2MdKVdTD+lHUw/5R1MP+UdTD/lHUw/5R1MP+UdTD/lHUw/5R1MP+UdTD/lHUw/5R1MP+UdTD/lHUw/5R1MP+VdTD+lHYx0pR2MY2WeDIzAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAnnkxFZd4MVOWdTF+lHUxpZR2McuVdjDflHYx7JR2MPmUdjD5lHYx7JV2MN+UdjHLlHUxpZZ1MX6XeDFTnnkxFQAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAP///wAA///////4AAAf/////8AAAAP/////AAAAAP////wAAAAAP///+AAAAAAf///wAAAAAA///+AAAAAAB///gAAAAAAB//8AAAAAAAD//wAAAAAAAP/+AAAAAAAAf/wAAAAAAAA/+AAAAAAAAB/wAAAAAAAAD/AAAAAAAAAP4AAAAAAAAAfgAAAAAAAAB8AAAAAAAAADwAAAAAAAAAPAAAAAAAAAA4AAAAAAAAABgAAAAAAAAAGAAAAAAAAAAQAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAgAAAAAAAAAGAAAAAAAAAAYAAAAAAAAABwAAAAAAAAAPAAAAAAAAAA8AAAAAAAAAD4AAAAAAAAAfgAAAAAAAAB/AAAAAAAAAP8AAAAAAAAA/4AAAAAAAAH/wAAAAAAAA//gAAAAAAAH//AAAAAAAA//8AAAAAAAD//4AAAAAAAf//4AAAAAAH///wAAAAAA////gAAAAAH////AAAAAA/////AAAAAP/////AAAAD//////gAAB///////wAA////',
                createTime: req.requestTime,
                del_flag: 0,
              };
              // 新增默认书签
              await pool.query('INSERT INTO bookmark set ?', [snakeCaseKeys(bookmarkData)]);

              const system = JSON.stringify({
                browser: req.headers['browser'] ?? '未知',
                os: req.headers['os'] ?? '未知',
                fingerprint: req.headers['fingerprint'] ?? '未知',
              });
              const requestPayload = JSON.stringify(req.method === 'GET' ? req.query : req.body);
              // 构造日志对象
              const log = {
                userId: userId,
                method: req.method,
                url: req.originalUrl,
                req: requestPayload === '{}' ? '' : requestPayload,
                ip: req.headers['x-forwarded-for'] ?? '未知',
                location: '未知',
                system: system,
                requestTime: req.requestTime, // 获取当前时间
                del_flag: 0,
              };
              // 将日志保存到数据库
              const query = 'INSERT INTO api_logs SET ?';
              await pool.query(query, [snakeCaseKeys(log)]).catch((err) => {
                console.error('注册日志更新错误: ' + err.message);
              });

              res.send(resultData(null, 200, '注册成功')); // 设置状态码为200
            })
            .catch((err) => {
              res.send(resultData(null, 500, '服务器内部错误' + err)); // 设置状态码为500
            });
        }
      })
      .catch((err) => {
        res.send(resultData(null, 500, '服务器内部错误' + err)); // 设置状态码为500
      });
  } catch (e) {
    res.send(resultData(null, 400, '客户端请求异常：' + e)); // 设置状态码为400
  }
};
export const getUserInfo = async (req, res) => {
  try {
    const id = req.headers['x-user-id']; // 获取用户ID
    const [userRes] = await pool.query('SELECT * FROM user WHERE id = ?', [id]);
    // 没有储存ip或者ip地址改变，则更新用户ip相关信息
    if (userRes[0].ip === null || userRes[0].ip !== req.headers['x-forwarded-for']) {
      const { data } = await request.get(
        `https://restapi.amap.com/v3/ip?ip=${req.headers['x-forwarded-for']}&key=d72f302bf6c39e1e6973a0d3bdbf302f`,
      );
      const location = {
        city: data.city ?? '接口错误，获取失败',
        province: data.province ?? '接口错误，获取失败',
        rectangle: data.rectangle ?? '接口错误，获取失败',
      };
      try {
        await pool.query('update user set location=? , ip=? where id=?', [
          JSON.stringify(location),
          req.headers['x-forwarded-for'],
          id,
        ]);
      } catch (e) {
        console.error('地理信息配置失败:', e.message);
        // 不发送响应，继续执行获取用户信息
      }
    }
    pool
      .query('SELECT * FROM user WHERE id = ?', [id])
      .then(async ([result]) => {
        if (result.length === 0) {
          res.send(resultData(null, 401, '用户不存在,请重新登录！')); // 设置状态码为401
          return;
        }
        if (result[0].del_flag === '1') {
          res.send(resultData(null, 401, '账号已被禁用')); // 设置状态码为401
          return;
        }
        const bookmarkTotalSql = `SELECT COUNT(*) FROM bookmark WHERE user_id=? and del_flag = 0`;
        const [bookmarkTotalRes] = await pool.query(bookmarkTotalSql, [id]);
        const tagTotalSql = `SELECT COUNT(*) FROM tag WHERE user_id=? and del_flag = 0`;
        const [tagTotalRes] = await pool.query(tagTotalSql, [id]);
        const noteTotalSql = `SELECT COUNT(*) FROM note WHERE create_by=? and del_flag = 0`;
        const [noteTotalRes] = await pool.query(noteTotalSql, [id]);
        const opinionTotalSql = `SELECT COUNT(*) FROM opinion WHERE  del_flag = 0`;
        const [opinionTotalRes] = await pool.query(opinionTotalSql, [id]);
        result[0].bookmarkTotal = bookmarkTotalRes[0]['COUNT(*)'];
        result[0].tagTotal = tagTotalRes[0]['COUNT(*)'];
        result[0].noteTotal = noteTotalRes[0]['COUNT(*)'];
        result[0].opinionTotal = opinionTotalRes[0]['COUNT(*)'];
        result[0].password = result[0].password ? '******' : '';
        if (result[0].role === 'visitor') {
          res.send(resultData(result[0], 'visitor'));
        } else {
          res.send(resultData(result[0]));
        }
      })
      .catch((err) => {
        res.send(resultData(null, 500, '服务器内部错误' + err)); // 设置状态码为500
      });
  } catch (e) {
    res.send(resultData(null, 400, '客户端请求异常' + e)); // 设置状态码为400
  }
};
export const getUserList = (req, res) => {
  try {
    const { filters, pageSize, currentPage } = validateQueryParams(req.body);
    const key = filters.key;
    const skip = pageSize * (currentPage - 1);
    let sql = `
      SELECT 
        u.id,
        u.alias,
        u.email,
        u.phone_number,
        u.role,
        u.theme,
        u.ip,
        u.create_time,
        u.password,
        u.del_flag,
        COALESCE(b.bookmark_count, 0) AS bookmarkTotal,
        COALESCE(t.tag_count, 0) AS tagTotal,
        COALESCE(n.note_count, 0) AS noteTotal,
        COALESCE(f.storage_used, 0) AS storageUsed
      FROM user u
      LEFT JOIN (
        SELECT user_id, COUNT(*) AS bookmark_count
        FROM bookmark
        WHERE del_flag = 0
        GROUP BY user_id
      ) b ON u.id = b.user_id
      LEFT JOIN (
        SELECT user_id, COUNT(*) AS tag_count
        FROM tag
        WHERE del_flag = 0
        GROUP BY user_id
      ) t ON u.id = t.user_id
      LEFT JOIN (
        SELECT create_by, COUNT(*) AS note_count
        FROM note
        WHERE del_flag = 0
        GROUP BY create_by
      ) n ON u.id = n.create_by
      LEFT JOIN (
        SELECT create_by, ROUND(SUM(file_size) / 1048576, 2) AS storage_used
        FROM files
        WHERE del_flag = 0
        GROUP BY create_by
      ) f ON u.id = f.create_by
      WHERE u.del_flag = 0 AND (u.alias LIKE CONCAT('%', ?, '%') OR u.email LIKE CONCAT('%', ?, '%'))
      ORDER BY u.create_time DESC
      LIMIT ? OFFSET ?
    `;
    pool
      .query(sql, [key, key, pageSize, skip])
      .then(async ([result]) => {
        const [totalRes] = await pool.query(
          "SELECT COUNT(*) FROM user WHERE del_flag=0 AND (alias LIKE CONCAT('%', ?, '%') OR email LIKE CONCAT('%', ?, '%'))",
          [key, key],
        );
        res.send(
          resultData({
            items: result,
            total: totalRes[0]['COUNT(*)'],
          }),
        );
      })
      .catch((err) => {
        res.send(resultData(null, 500, '服务器内部错误' + err)); // 设置状态码为500
      });
  } catch (e) {
    res.send(resultData(null, 400, '客户端请求异常' + e)); // 设置状态码为400
  }
};

export const saveUserInfo = (req, res) => {
  try {
    const id = req.body.id ? req.body.id : req.headers['x-user-id']; // 获取用户ID
    pool
      .query('update user set ? where id=?', [snakeCaseKeys(mergeExistingProperties(req.body, [], ['id'])), id])
      .then(([result]) => {
        res.send(resultData(result));
      })
      .catch((err) => {
        res.send(resultData(null, 500, '服务器内部错误: ' + err.message)); // 设置状态码为500
      });
  } catch (e) {
    res.send(resultData(null, 400, '客户端请求异常：' + e)); // 设置状态码为400
  }
};

export const deleteUserById = (req, res) => {
  try {
    pool
      .query('update user set del_flag=1 where id=?', [req.query.id])
      .then(([result]) => res.send(resultData(result)))
      .catch((err) => res.send(resultData(null, 500, '服务器内部错误: ' + err.message)));
  } catch (e) {
    res.send(resultData(null, 400, '客户端请求异常：' + e)); // 设置状态码为400
  }
};

export const github = async (req, res) => {
  const { code } = req.body;
  if (!code) return res.status(400).json({ error: 'Missing authorization code' });

  try {
    // 1. 用 code 换取 GitHub Token
    const tokenData = await fetchGitHubToken(code);
    if (!tokenData.access_token) throw new Error('Failed to obtain access token');

    // 2. 获取基础用户信息和邮箱信息
    const [baseUser, email] = await Promise.all([
      getGitHubUser(tokenData.access_token),
      getGitHubEmail(tokenData.access_token), // 单独获取邮箱
    ]);
    const safeEmail = email || `${baseUser.login}@users.noreply.github.com`;
    // 合并用户对象
    const githubUser = { ...baseUser, email: safeEmail };

    // 3. 数据库操作（查找/创建用户）
    const user = await handleUserDatabaseOperation(githubUser);

    res.send(
      resultData({
        user_info: {
          id: user.id,
          alias: user.alias,
          head_picture: user.head_picture,
          role: user.role ?? 'admin',
        },
        requires_email: !githubUser.email, // 标识是否需要补全邮箱
      }),
    );
  } catch (error) {
    console.error('GitHub Auth Error:', error);
    res.send(resultData(null, 500, 'GitHub认证失败：' + error));
  }
};

// --- 工具函数 ---
const fetchGitHubToken = async (code) => {
  const params = new URLSearchParams();
  params.append('client_id', process.env.GITHUB_CLIENT_ID); // 改用环境变量
  params.append('client_secret', process.env.GITHUB_CLIENT_SECRET);
  params.append('code', code);

  try {
    const response = await fetchWithTimeout(
      'https://github.com/login/oauth/access_token',
      {
        method: 'POST',
        headers: { Accept: 'application/json' },
        body: params,
      },
      8000, // 8秒超时
    );

    if (!response.ok) {
      const errorBody = await response.text();
      throw new Error(`GitHub token request failed: ${response.status} - ${errorBody}`);
    }
    return response.json();
  } catch (error) {
    console.error('fetchGitHubToken Error:', error.message);
    throw error;
  }
};

const getGitHubUser = async (accessToken) => {
  const response = await fetch('https://api.github.com/user', {
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'User-Agent': 'MyApp',
    },
  });

  if (!response.ok) {
    throw new Error(`GitHub API error: ${response.statusText}`);
  }
  return response.json();
};

// 新增：专门获取邮箱的API调用
const getGitHubEmail = async (accessToken, retries = 2) => {
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const response = await fetchWithTimeout(
        'https://api.github.com/user/emails',
        {
          headers: {
            Authorization: `Bearer ${accessToken}`,
            Accept: 'application/vnd.github.v3+json',
          },
        },
        5000, // 5秒超时
      );

      if (!response.ok) continue; // 重试

      const emails = await response.json();
      const primaryEmail = emails.find((e) => e.primary && e.verified);
      return primaryEmail?.email || null;
    } catch (error) {
      if (attempt === retries) {
        console.warn('Fallback to no-reply email after retries');
        return null; // 由调用方统一降级
      }
    }
  }
};

const handleUserDatabaseOperation = async (githubUser) => {
  // 邮箱降级策略：使用GitHub提供的备用邮箱格式
  const safeEmail = githubUser.email || `${githubUser.login}@users.noreply.github.com`;

  // 1. 优先使用github_id查询
  const [existingByGithub] = await pool.query(`SELECT * FROM user WHERE github_id = ? LIMIT 1`, [githubUser.id]);
  if (existingByGithub.length > 0) return existingByGithub[0];

  // 2. 使用邮箱查询现有账户
  const [existingByEmail] = await pool.query(`SELECT * FROM user WHERE email = ? LIMIT 1`, [safeEmail]);

  if (existingByEmail.length > 0) {
    // 绑定GitHub ID到现有账户
    await pool.query(`UPDATE user SET github_id = ?, login_type = 'github' WHERE id = ?`, [
      githubUser.id,
      existingByEmail[0].id,
    ]);

    // 返回更新后的完整用户数据
    const [updatedUser] = await pool.query(`SELECT * FROM user WHERE id = ? LIMIT 1`, [existingByEmail[0].id]);
    return updatedUser[0];
  }

  // 3. 创建新用户
  const [result] = await pool.query(
    `INSERT INTO user 
      (email, github_id, login_type, head_picture)
     VALUES (?, ?, ?, 'github', ?)`,
    [githubUser.login, safeEmail, githubUser.id, githubUser.avatar_url],
  );

  // 返回新插入的完整用户数据
  const [newUser] = await pool.query(`SELECT * FROM user WHERE id = ? LIMIT 1`, [result.insertId]);
  return newUser[0];
};

// 修改密码或者设置密码configPassword

export const configPassword = async (req, res) => {
  try {
    const id = req.headers['x-user-id']; // 获取用户ID
    const { password, type } = req.body;
    const [oldUser] = await pool.query(`SELECT * FROM user WHERE id = ? LIMIT 1`, [id]);
    if (type === 'update') {
      const { oldPassword } = req.body;
      if (oldUser[0].password !== oldPassword) {
        throw new Error('原密码错误');
      }
      if (oldUser[0].password === password) {
        throw new Error('新密码不能与原密码相同');
      }
    }
    pool
      .query('update user set password=? where id=?', [password, id])
      .then(([result]) => {
        res.send(resultData(result));
      })
      .catch((err) => {
        res.send(resultData(null, 500, '服务器内部错误: ' + err.message)); // 设置状态码为500
      });
  } catch (e) {
    res.send(resultData(null, 400, e.message)); // 设置状态码为400
  }
};

// 发送验证码接口
export const sendEmail = async (req, res) => {
  try {
    const { email } = req.body;
    const code = Math.floor(100000 + Math.random() * 900000).toString(); // 6位数字验证码

    // 1. 存储验证码到Redis（5分钟过期）
    await redisClient.setEx(`email:code:${email}`, 300, code);

    // 2. 发送邮件
    const mailOptions = {
      from: '"轻笺"<1902013368@qq.com>',
      to: email,
      subject: '【轻笺】验证邮件',
      html: `
        <p>您好！</p>
        <p>您的验证码是：<strong style="color:orangered;">${code}</strong></p>
        <p>有效期5分钟，请勿泄露</p>
        <p>如果不是您本人操作，请无视此邮件</p>
      `,
    };

    await nodeMail.sendMail(mailOptions);
    res.send(resultData('验证码发送成功'));
  } catch (e) {
    console.error('邮件发送异常:', e);
    res.send(resultData(null, 500, '邮件发送失败:' + e.message)); // 设置状态码为400
  }
};

// 验证验证码接口
export const verifyCode = async (req, res) => {
  try {
    const { email, code, password } = req.body;

    // 1. 从Redis获取存储的验证码
    const storedCode = await redisClient.get(`email:code:${email}`);

    // 2. 验证逻辑
    if (!storedCode) {
      res.send(resultData(null, 400, '验证码已过期或未发送'));
      return;
    }
    if (storedCode !== code) {
      res.send(resultData(null, 400, '验证码错误'));
      return;
    }
    // 3. 验证成功后，删除已用验证码并且设置新密码
    await redisClient.del(`email:code:${email}`);
    pool
      .query('update user set password=? where email=?', [password, email])
      .then(() => {
        res.send(resultData('重置密码成功'));
      })
      .catch((err) => {
        res.send(resultData(null, 500, '服务器内部错误: ' + err.message)); // 设置状态码为500
      });
  } catch (e) {
    res.send(resultData(null, 500, '验证服务异常:' + e.message)); // 设置状态码为400
  }
};
