# 百度语音合成 Pot 插件

基于百度「短文本在线合成」接口，为 [Pot](https://pot-app.com/) 提供中英文朗读。

## 获取 API Key 与 Secret Key

1. 打开[百度智能云语音技术控制台](https://console.bce.baidu.com/ai-engine/speech/overview/index?type=1)
   ，登录百度账号；没有账号先注册并完成实名认证，个人认证即可使用免费额度。
2. 在语音技术控制台里创建API应用。
3. 创建完成后会自动弹出应用详情，复制 **API Key** 和 **Secret Key**——插件里要填的是这两个值， **不是 App ID**。
4. 免费版有 10 万调用次数，可以用很久了（余额为零时服务暂停，不会欠费）。

密钥长期有效；遇到 `502 token 验证失败`，先回控制台核对密钥是否被重置、应用是否仍有语音合成权限。
