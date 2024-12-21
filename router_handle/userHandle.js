const pool = require("../db");
const {resultData, snakeCaseKeys, mergeExistingProperties, getCurrentTimeFormatted} = require("../util/result");

exports.login = (req, res) => {
    try {
        const {userName, password} = req.body;
        const sql = "SELECT * FROM user WHERE user_name = ? AND password = ?";
        pool
            .query(sql, [userName, password])
            .then(async ([result]) => {
                if (result.length === 0) {
                    res.send(resultData(null, 401, "用户名密码错误或已过期，请重新输入")); // 设置状态码为401
                    return;
                }
                const bookmarkTotalSql = `SELECT COUNT(*) FROM bookmark WHERE user_id=? and del_flag = 0`;
                const [bookmarkTotalRes] = await pool.query(bookmarkTotalSql, [result[0].id]);
                const tagTotalSql = `SELECT COUNT(*) FROM tag WHERE user_id=? and del_flag = 0`;
                const [tagTotalRes] = await pool.query(tagTotalSql, [result[0].id]);
                result[0].bookmarkTotal = bookmarkTotalRes[0]["COUNT(*)"];
                result[0].tagTotal = tagTotalRes[0]["COUNT(*)"];
                res.send(resultData(result[0]));
            })
            .catch((err) => {
                res.send(resultData(null, 500, "服务器内部错误: " + err.message)); // 设置状态码为500
            });
    } catch (e) {
        res.send(resultData(null, 400, "客户端请求异常：" + e)); // 设置状态码为400
    }
};

exports.registerUser = (req, res) => {
    try {
        pool
            .query("SELECT * FROM user WHERE user_name = ?", [req.body.userName])
            .then(([result]) => {
                if (result?.length > 0) {
                    res.send(resultData(null, 500, "账号已存在")); // 设置状态码为500
                } else {
                    const params=req.body
                    params.createTime=getCurrentTimeFormatted()
                    pool
                        .query("INSERT INTO user set ?", [snakeCaseKeys(params)])
                        .then(async () => {
                            const [userRes] = await pool
                                .query("SELECT * FROM USER WHERE user_name=?", [req.body.userName])
                                const userId = userRes[0].id
                                const tagData = {
                                    name: '标签示例',
                                    userId: userId,
                                    iconUrl: 'data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHdpZHRoPSIxZW0iIGhlaWdodD0iMWVtIiB2aWV3Qm94PSIwIDAgMTYgMTYiPjxwYXRoIGZpbGw9IiM2YzgyZmYiIGQ9Ik02LjkyMyAxLjM3OGEzIDMgMCAwIDEgMi4xNTQgMGw0Ljk2MiAxLjkwOGExLjUgMS41IDAgMCAxIC45NjEgMS40djYuNjI2YTEuNSAxLjUgMCAwIDEtLjk2MSAxLjRsLTQuOTYyIDEuOTA5YTMgMyAwIDAgMS0yLjE1NCAwbC00Ljk2MS0xLjkwOWExLjUgMS41IDAgMCAxLS45NjItMS40VjQuNjg2YTEuNSAxLjUgMCAwIDEgLjk2Mi0xLjR6bTEuNzk1LjkzM2EyIDIgMCAwIDAtMS40MzYgMGwtMS4zODQuNTMzbDUuNTkgMi4xMTZsMS45NDgtLjgzNHpNMTQgNC45NzFMOC41IDcuMzN2Ni40MjhxLjExLS4wMjguMjE4LS4wN2w0Ljk2Mi0xLjkwOGEuNS41IDAgMCAwIC4zMi0uNDY3em0tNi41IDguNzg2VjcuMzNMMiA0Ljk3MnY2LjM0YS41LjUgMCAwIDAgLjMyLjQ2N2w0Ljk2MiAxLjkwOHEuMTA3LjA0Mi4yMTguMDdNMi41NjQgNC4xMjZMOCA2LjQ1NmwyLjE2NC0uOTI4bC01LjY2Ny0yLjE0NnoiLz48L3N2Zz4=',
                                    createTime: getCurrentTimeFormatted(),
                                    del_flag: 0,
                                }
                            const bookmarkData={
                                name: '书签示例',
                                userId: userId,
                                url:'boluo66.top',
                                description:'一个免费的智能在线书签管理小工具',
                                iconUrl: 'data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHdpZHRoPSIxZW0iIGhlaWdodD0iMWVtIiB2aWV3Qm94PSIwIDAgMTI4IDEyOCI+PGRlZnM+PHBhdGggaWQ9Im5vdG9Cb29rbWFyazAiIGZpbGw9IiM4NzRkMzYiIGQ9Ik0yNC43OSAzOS41MWMtNi41NS0xLjU0LTEyLjUyLTUuNDQtMTYuNDktMTAuOTJsLTEuMDUtMS40NWMtLjcyLTEtLjUtMi40LjUtMy4xMmwyLjktMi4xYzEtLjcyIDIuNC0uNSAzLjEyLjVsMS4wNSAxLjQ1YzMuNDMgNC43MyA4Ljk1IDcuODIgMTQuNzcgOC4yNmw0LjAxLjMxbC0uNjIgOC4wM2wtNC4wMS0uMzFjLTEuNC0uMTEtMi44LS4zMi00LjE4LS42NSIvPjxwYXRoIGlkPSJub3RvQm9va21hcmsxIiBmaWxsPSIjODc0ZDM2IiBkPSJtMzEuODIgNDQuNjNsLS41LTMuOTlhNDEuNSA0MS41IDAgMCAwLTE3LjIxLTI4Ljc1bC0xLjMyLS45M2EyLjQwNSAyLjQwNSAwIDAgMS0uNTctMy4zNmwxLjg3LTIuNjRhMi40MTYgMi40MTYgMCAwIDEgMy4zNi0uNThsMS4zMS45M2E0OS42IDQ5LjYgMCAwIDEgMjAuNTYgMzQuMzNsLjUgMy45OXoiLz48cGF0aCBpZD0ibm90b0Jvb2ttYXJrMiIgZmlsbD0iI2ZjZWJjZCIgZD0ibTY1LjQ0IDY4LjQ4bDcuMDggMy4yM2w2LjY4LTRsLS44OSA3Ljc0bDUuODcgNS4xMWwtNy42MyAxLjU1bC0zLjA1IDcuMTZsLTMuODMtNi43OGwtNy43Ni0uNjhsNS4yNy01Ljc0eiIvPjwvZGVmcz48dXNlIGhyZWY9IiNub3RvQm9va21hcmswIi8+PHVzZSBocmVmPSIjbm90b0Jvb2ttYXJrMCIvPjxwYXRoIGZpbGw9IiNkZTczNDAiIGQ9Ik0xMC42NSAyMS45MmMtLjg1LjYyLTEuMjcuOTItMi4yOSAxLjY2Yy0xLjI1LjkxIDIuMzUgNS43OSA2LjE0IDguNDVjMS40NCAxLjAxIDUuNjYgMS42IDYuMjctLjkxYy4xNC0uNTgtLjA2LTEuMjEtLjQtMS43MWMtLjU4LS44NC0xLjUyLTEuNC0yLjI5LTIuMDVjLTEuMjItMS4wMy0yLjMyLTIuMi0zLjI2LTMuNDlsLTEuMDUtMS40NWMtLjcyLTEtMi4xMi0xLjIyLTMuMTItLjUiLz48cGF0aCBmaWxsPSIjNGUzNDJlIiBkPSJNMjUuMyAzMS4zMmMxLjMyIDEuOTYgMi4wOSA1LjQxIDIuMDYgNy43N2wzLjI5LTIuODdjLS43NS0zLjQ4LTEuMzQtNC4xNS0xLjM0LTQuMTVjLTEuNTctLjEyLTQuMDEtLjc1LTQuMDEtLjc1Ii8+PHVzZSBocmVmPSIjbm90b0Jvb2ttYXJrMSIvPjx1c2UgaHJlZj0iI25vdG9Cb29rbWFyazEiLz48cGF0aCBmaWxsPSIjZjQ0MzM2IiBkPSJNMTkuMzcgNTEuODdzMjEuNyA1Mi4wOCA3Ni41MyA3MC40NGMyLjI0Ljc1IDQuNDItMS4yOSAzLjg3LTMuNTlsLTUuNjMtMjMuMDljLS4yMS0uODcuNC0xLjcyIDEuMy0xLjgxYzkuNzEtLjkyIDE3Ljk0LTIuNzQgMjMuMjUtNC4xNWMyLjUxLS42NiAzLjA3LTMuOTguOTEtNS40MWMtNDAuMzQtMjYuNzUtNjMuMS02Mi42MS02My4xLTYyLjYxYTUuMTMgNS4xMyAwIDAgMC03LjIyLS43NEwyMC4xMSA0NC42NmMtMy4wOSAyLjQyLS43NCA3LjIxLS43NCA3LjIxbTIwLjQ4LTMuOTJjLTEuOTYtMi40MS0xLjYtNS45NS44MS03LjkxczUuOTUtMS42IDcuOTEuODFhNS42MiA1LjYyIDAgMCAxLS44MSA3LjkxYTUuNjIgNS42MiAwIDAgMS03LjkxLS44MSIvPjxwYXRoIGZpbGw9IiM4NzRkMzYiIGQ9Ik0zOS42NSA0NC4xMmMtLjMxLjA1LS42Mi4wNS0uOTEtLjA1Yy0xLjA5LS4zNy0xLjA0LTEuODQtMS40OC0yLjczYy0uNTMtMS4wNy0xLjI2LTIuMDMtMi4xLTIuODhjLS45LS45Mi0xLjkzLTEuODItMy4xOS0yLjE5Yy0uNTgtLjE3LTEuMTQtLjE0LTEuNjkuMDdjLjEzLS41My0uMDMtMS4wOS4xLTEuNjVjLjMyLTEuNDEgMS4zOS0yLjc0IDIuNTQtMy41N2MuOS0uNjYgMS44OC0xLjI4IDIuOTYtMS41OGMxLjE3LS4zMiAyLjAxLS4wMiAzLjA3LjVjMS44OS45MyAzLjUzIDIuMzggNC43MSA0LjEzYzEuNjEgMi4zOSAyLjY2IDUuMDQuMzQgNy4zMWMtLjk2Ljk0LTIuMDggMS43Mi0zLjI5IDIuMjljLS4zNS4xNC0uNy4yOC0xLjA2LjM1Ii8+PHBhdGggZmlsbD0iI2RlNzM0MCIgZD0iTTM1LjUxIDMwLjc0YzEuMjEtLjQ0IDIuNzQtLjIyIDMuNzMuMmMuNDcuMiAxLjQ3IDEuMTEgMS40OCAxLjgxYzAgMS4wNi0uOTMgMS44OC0yLjEgMi42OGMtMS4wNC43OS0yLjA0IDEuMS0zLjIyLjRjLTEuMDQtLjU2LTMuNjktMS4wMy0zLjQyLTEuOTNjLjQtMS4zOSAyLjI0LTIuNjkgMy41My0zLjE2TTExLjc5IDkuNDJzLjI4LS44NCAxLjAzLS45NlMxNy43NiAxMC44IDIxLjggMTVjMi42OSAyLjggNy41NiAxMCA4LjM3IDEwLjQzYy41Ny4zIDEuMjcuNDUgMS44NS4xN2MuODktLjQ0IDEuMDUtMS42NC45My0yLjYzYy0uNDgtMy43OS0yLjc1LTYuNi01LjE4LTkuNDRhNDkuNiA0OS42IDAgMCAwLTkuMDItOC4yM2wtMS4zMS0uOTNjLTEuMDktLjc3LTIuMjgtLjg3LTMuMzcuMzdjLS4wMS4wMS0yLjgzIDMuMTktMi4yOCA0LjY4Ii8+PHVzZSBocmVmPSIjbm90b0Jvb2ttYXJrMiIvPjx1c2UgaHJlZj0iI25vdG9Cb29rbWFyazIiLz48L3N2Zz4=',
                                createTime: getCurrentTimeFormatted(),
                                del_flag: 0,
                            }
                            // 新增标签和书签
                             await  pool
                                    .query("INSERT INTO tag set ?", [snakeCaseKeys(tagData)])
                            await pool
                                .query("INSERT INTO bookmark set ?", [snakeCaseKeys(bookmarkData)])

                            // 获取新增的标签和书签
                            const [newTag]=await pool
                                .query("SELECT * FROM TAG WHERE user_Id=? ORDER BY create_time DESC LIMIT 1", [userId])
                            const [newBookmark]=await pool
                                .query("SELECT * FROM BOOKMARK WHERE user_Id=? ORDER BY create_time DESC LIMIT 1", [userId])
                            // 将新增的书签和标签关联
                            await pool.query('INSERT INTO tag_bookmark_relation (tag_id, bookmark_id) VALUES (?,?)',[newTag[0].id,newBookmark[0].id])
                            res.send(resultData(null, 200, "注册成功")); // 设置状态码为200
                        });
                }
            })
            .catch((err) => {
                res.send(resultData(null, 500, "服务器内部错误" + err)); // 设置状态码为500
            });
    } catch (e) {
        res.send(resultData(null, 400, "客户端请求异常：" + err)); // 设置状态码为400
    }
};

exports.getUserInfo = (req, res) => {
    try {
        const id = req.headers['x-user-id'] // 获取用户ID
        pool
            .query("SELECT * FROM user WHERE id = ?", [id])
            .then(async ([result]) => {
                if (result.length === 0) {
                    res.send(resultData(null, 401, "用户不存在,请重新登录！")); // 设置状态码为401
                    return;
                }
                const bookmarkTotalSql = `SELECT COUNT(*) FROM bookmark WHERE user_id=? and del_flag = 0`;
                const [bookmarkTotalRes] = await pool.query(bookmarkTotalSql, [id]);
                const tagTotalSql = `SELECT COUNT(*) FROM tag WHERE user_id=? and del_flag = 0`;
                const [tagTotalRes] = await pool.query(tagTotalSql, [id]);
                result[0].bookmarkTotal = bookmarkTotalRes[0]["COUNT(*)"];
                result[0].tagTotal = tagTotalRes[0]["COUNT(*)"];
                res.send(resultData(result[0]));
            })
            .catch((err) => {
                res.send(resultData(null, 500, "服务器内部错误" + err)); // 设置状态码为500
            });
    } catch (e) {
        res.send(resultData(null, 400, "客户端请求异常")); // 设置状态码为400
    }
};
exports.getUserList = (req, res) => {
    try {
        pool
            .query(`SELECT * FROM user where del_flag=0`)
            .then(([result]) => {
                res.send(resultData(result));
            })
            .catch((err) => {
                res.send(resultData(null, 500, "服务器内部错误" + err)); // 设置状态码为500
            });
    } catch (e) {
        res.send(resultData(null, 400, "客户端请求异常")); // 设置状态码为400
    }
};
exports.saveUserInfo = (req, res) => {
    const id =req.body.id?req.body.id: req.headers['x-user-id'] // 获取用户ID
    try {
        pool
            .query("update user set ? where id=?", [
                snakeCaseKeys(mergeExistingProperties(req.body, [], ['id'])),
                id,
            ])
            .then(([result]) => {
                res.send(resultData(result));
            })
            .catch((err) => {
                res.send(resultData(null, 500, "服务器内部错误: " + err.message)); // 设置状态码为500
            });
    } catch (e) {
        res.send(resultData(null, 400, "客户端请求异常：" + e)); // 设置状态码为400
    }
};

exports.deleteUserById = (req, res) => {
    try {
        pool
            .query("update user set del_flag=1 where id=?", [req.query.id])
            .then(([result]) => res.send(resultData(result)))
            .catch((err) =>
                res.send(resultData(null, 500, "服务器内部错误: " + err.message)),
            );
    } catch (e) {
        res.send(resultData(null, 400, "客户端请求异常：" + e)); // 设置状态码为400
    }
};
