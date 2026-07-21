# 异环午夜猫刊亭统计

在完美世界客服中心的「物品流向自助查询」页面中，统计午夜猫刊亭活动的消费、收入、盈亏和回报率。

## 安装

安装前，需要先在浏览器中安装一个支持用户脚本的扩展，例如 [Tampermonkey（油猴）](https://www.tampermonkey.net/) 或 Violentmonkey。

**[点击这里直接安装脚本](https://raw.githubusercontent.com/laipz8200/yihuan-cat-kiosk-stats/main/yihuan_cat_kiosk_stats.user.js)**

打开链接后，在用户脚本扩展的安装页面中确认安装即可。

## 使用

1. 登录完美世界客服中心并打开[物品流向自助查询](https://kf.wanmei.com/selfItemFlowQuery?gameId=191)。
2. 选择角色并勾选《完美世界游戏用户自助服务规则》。
3. 点击页面新增的「查询活动累计」或「查询过去 24 小时」按钮。

活动累计查询会自动拆分成不超过 7 天的区间，再汇总消费、收入、盈亏与回报率。回报率按 `收入 ÷ 消费 × 100%` 计算。

## 隐私

脚本仅在 `kf.wanmei.com` 的物品流向查询页面运行，使用当前浏览器登录状态发起查询，不会向第三方发送查询数据。

## 许可证

[GNU General Public License v3.0](LICENSE)

本项目是非官方工具，与游戏运营方无隶属关系。
