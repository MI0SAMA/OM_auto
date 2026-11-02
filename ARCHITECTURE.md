# 代码架构

## 后端

`run.py` 启动本地 HTTP 服务。`om_auto/server.py` 负责请求解析、路由、响应格式及少量图片和模板的文件/数据库编排；导入、识别、选点等较复杂的业务逻辑分在以下模块：

| 模块 | 职责 |
| --- | --- |
| `store.py` | SQLite 表结构、迁移和数据访问 |
| `ingest.py` | Pad/测量数据校验与 CSV、Excel 导入导出 |
| `planning.py` | 自动或人工调整后的选点方案生成与保存 |
| `detection.py` | 图片分块检测、区域格点拟合与人工修正合并 |
| `core.py` | 面积、几何分组、抽样及描述统计 |
| `vision.py`, `lattice.py`, `calibration.py` | 图像候选、规则版图和标尺算法 |

HTTP 接口保持 `/api/...` 路径。开发新功能时，先把可独立验证的业务规则放入相应模块，再在 `server.py` 接入路由。

## 前端

前端仍为无需构建工具的浏览器 JavaScript。`index.html` 按顺序加载：

1. `app.js`：DOM、API、表格、统计等共用函数。
2. `state.js`：页面状态。
3. `om_helpers.js`：区域框、人工修正与标尺的共用逻辑。
4. `sampling.js`：选点清单与可视化。
5. `pad_map.js`：样品 Pad 分布图。
6. `om_view.js`：整片图、放大图和候选叠加。
7. `controller.js`：样品加载、模板、测试结果与选点操作。
8. `workspace.js`：样品列表、URL 导航、步骤状态与逐区域核对。
9. `om_actions.js`：图像上传、识别、补点和保存；最后启动页面加载。

这些脚本当前共享 `state` 和少量全局函数。后续重做前端时可以逐模块迁移；修改某一视图时，应保持其脚本在 `index.html` 与 `server.py` 的静态文件白名单中同步登记。

## 数据与验证

运行数据默认写在 `data/`，可用 `OM_AUTO_DATA` 改目录。该目录不进入 Git。`python -m pytest -q` 验证业务规则；修改 HTTP 或页面加载链后，还应检查本地服务的接口与浏览器脚本能正常加载。真实图像测试脚本 `real_image_e2e.py` 使用隔离数据库，要求传入适配 `54#` 版图的图片。
