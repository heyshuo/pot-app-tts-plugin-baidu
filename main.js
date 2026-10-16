const TOKEN_URL = "https://aip.baidubce.com/oauth/2.0/token";
const TTS_URL = "https://tsn.baidu.com/text2audio";
const DEFAULT_TIMEOUT_SECONDS = 15;

// 百度把发音人分成基础音库和其他（精品/臻品/大模型）。
// 基础音库只有这 4 个编号，音量最高只能到 9，超出会被百度拒绝（报 err_no 501）。
// 其他音库的音量可以到 15。
const BASIC_VOICE_IDS = [0, 1, 3, 4];
const BASIC_VOLUME_MAX = 9;
const FULL_VOLUME_MAX = 15;

// 用来记住上次拿到的 access_token，避免每次朗读都要先请求一次 token。
// Pot 加载插件后这个变量就一直活着，所以多次朗读之间能复用。
let accessTokenCache = {
    apiKey: "",
    secretKey: "",
    token: "",
    expiresAt: 0,
};

// 把用户填的配置值转成整数。Pot 的下拉框传回来的都是字符串，
// 所以这里统一转换；不是数字或超出范围就退回默认值，不报错。
function readNumber(value, defaultValue, minimum, maximum) {
    if (value === undefined || value === null || String(value).trim() === "") {
        return defaultValue;
    }

    const numberValue = Number(value);
    if (!Number.isFinite(numberValue) || !Number.isInteger(numberValue)) {
        return defaultValue;
    }
    if (numberValue < minimum || numberValue > maximum) {
        return defaultValue;
    }
    return numberValue;
}

// 处理音频格式（aue 参数）。百度其实还支持 pcm 格式（4 和 5），
// 但 pcm 是没有文件头的裸数据，Pot 播放时解不出来，而且不报错、就是没声音，
// 所以这里只放行 mp3（3）和 wav（6），填了别的一律按 mp3 处理。
function readAudioFormat(value) {
    const audioFormat = readNumber(value, 3, 3, 6);
    if (audioFormat === 3 || audioFormat === 6) {
        return audioFormat;
    }
    return 3;
}

// 把用户填的文本框内容转成字符串，顺手去掉前后空格；没填就是空字符串。
function readText(value) {
    if (value === undefined || value === null) {
        return "";
    }
    return String(value).trim();
}

// 读取并检查插件配置。没有密钥百度不会受理请求，所以必填项缺失就直接报错。
function readConfig(options) {
    // options 可能不存在（比如别的程序误调用），先兜底成空对象。
    const rawConfig = options && options.config && typeof options.config === "object"
        ? options.config
        : {};
    const apiKey = readText(rawConfig.apiKey);
    const secretKey = readText(rawConfig.secretKey);

    if (apiKey.length === 0) {
        throw "未填写 API Key，请到插件配置里填写";
    }
    if (secretKey.length === 0) {
        throw "未填写 Secret Key，请到插件配置里填写";
    }

    // 发音人编号不设上限：百度以后会加新音色，写死范围反而挡住新编号。
    const per = readNumber(rawConfig.per, 0, 0, Number.MAX_SAFE_INTEGER);
    // 音量上限取决于发音人，所以先算 per。
    const volumeMax = BASIC_VOICE_IDS.includes(per) ? BASIC_VOLUME_MAX : FULL_VOLUME_MAX;

    return {
        apiKey,
        secretKey,
        per,
        spd: readNumber(rawConfig.spd, 5, 0, 15),
        pit: readNumber(rawConfig.pit, 5, 0, 15),
        vol: readNumber(rawConfig.vol, 5, 0, volumeMax),
        aue: readAudioFormat(rawConfig.aue),
        timeout: readNumber(rawConfig.timeout, DEFAULT_TIMEOUT_SECONDS, 1, 300),
    };
}

// Pot 会把网络请求相关的工具塞进 options.utils 传给插件。
// 这里确认需要的东西都在，缺了就明确报错，
// 不然到真正发请求的时候才失败，用户看到的错误会莫名其妙。
function readRuntime(options) {
    const runtimeUtils = options && options.utils && typeof options.utils === "object"
        ? options.utils
        : {};
    const tauriFetch = runtimeUtils.tauriFetch;
    const bodyFactory = runtimeUtils.http && runtimeUtils.http.Body;

    if (typeof tauriFetch !== "function") {
        throw "插件运行环境缺少网络请求能力，请更新 Pot 后重试";
    }
    if (!bodyFactory || typeof bodyFactory.form !== "function") {
        throw "插件运行环境缺少表单请求能力，请更新 Pot 后重试";
    }

    return {tauriFetch, bodyFactory};
}

// 判断 HTTP 响应是不是成功（状态码 2xx）。
// 优先用 response.ok，旧版本的 Tauri 没有这个字段，就退回看 status。
function isSuccessfulResponse(response) {
    if (!response || typeof response !== "object") {
        return false;
    }
    if (typeof response.ok === "boolean") {
        return response.ok;
    }

    const status = Number(response.status);
    return status >= 200 && status < 300;
}

// 把各种形态的报错统一转成字符串，方便拼进提示里给用户看。
function getErrorMessage(error) {
    if (error instanceof Error && error.message) {
        return error.message;
    }
    if (error === undefined || error === null) {
        return "未知错误";
    }
    return String(error);
}

// 网络请求本身挂了（没连上、断网、超时）时的提示。
// Tauri 请求超时是靠 reject 一个错误对象实现的，错误文字里带 timeout，
// 所以靠文字判断是不是超时，超时给专门的提示，其他给通用提示。
function describeNetworkFailure(error) {
    const message = getErrorMessage(error);
    const lowerMessage = message.toLowerCase();
    if (lowerMessage.includes("timeout") || lowerMessage.includes("timed out")) {
        return "请求超时，请检查网络或到插件配置中调大超时时间";
    }
    return "网络请求失败，请检查网络连接后重试";
}

// 判断 token 接口返回的是不是「密钥填错了」。
// 密钥错的时候百度返回 {"error": "invalid_client", ...} 这种结构。
function isCredentialError(data) {
    if (!data || typeof data !== "object") {
        return false;
    }

    const errorCode = String(data.error || "").toLowerCase();
    const description = String(data.error_description || "").toLowerCase();
    return errorCode === "invalid_client"
        || errorCode === "invalid_client_credentials"
        || description.includes("unknown client id")
        || description.includes("client secret");
}

// 拿 access_token。百度要求先用自己的 API Key + Secret Key 换一个临时令牌，
// 之后合成语音时都带着这个令牌，令牌有效期 30 天左右。
async function fetchAccessToken(config, tauriFetch) {
    // 缓存里记着「这个 token 是用哪组密钥换来的」：
    // 密钥没换、token 也没过期，就直接复用，不发请求。
    const now = Date.now();
    const cacheMatches = accessTokenCache.apiKey === config.apiKey
        && accessTokenCache.secretKey === config.secretKey;
    if (cacheMatches && accessTokenCache.token && now < accessTokenCache.expiresAt) {
        return accessTokenCache.token;
    }

    let response;
    try {
        response = await tauriFetch(TOKEN_URL, {
            method: "POST",
            query: {
                grant_type: "client_credentials",
                client_id: config.apiKey,
                client_secret: config.secretKey,
            },
            timeout: config.timeout,
            responseType: 1,
        });
    } catch (error) {
        throw describeNetworkFailure(error);
    }

    const data = response && response.data && typeof response.data === "object"
        ? response.data
        : {};
    // 密钥错误是最常见的问题，单独判断，给用户能看懂的提示。
    if (isCredentialError(data)) {
        throw "API Key / Secret Key 不正确，请到插件配置里检查后重试";
    }
    if (!isSuccessfulResponse(response)) {
        const status = response && response.status !== undefined ? response.status : "未知";
        throw `获取 access_token 的网络请求失败（HTTP 状态码：${status}）`;
    }
    if (data.error) {
        const detail = data.error_description || data.error;
        throw `获取 access_token 失败：${detail}`;
    }
    if (typeof data.access_token !== "string" || data.access_token.length === 0) {
        throw "获取 access_token 失败：响应中没有 access_token";
    }

    // 百度会告诉我们 token 能用多久（expires_in，单位秒）。
    // 提前五分钟当作过期，避免拿着缓存去请求的时候 token 刚好失效。
    const expiresIn = Number(data.expires_in);
    const validSeconds = Number.isFinite(expiresIn) && expiresIn > 0 ? expiresIn : 3600;
    accessTokenCache = {
        apiKey: config.apiKey,
        secretKey: config.secretKey,
        token: data.access_token,
        expiresAt: now + Math.max(validSeconds - 300, 0) * 1000,
    };
    return accessTokenCache.token;
}

// cuid 是调用方的设备标识，百度拿它做统计，随便一个固定格式的随机串就行，
// 限制在 60 字符以内。
function createCuid() {
    // toString(36) 是把数字转成用 0-9 和 a-z 表示的字符串，短而且不含特殊符号。
    const timePart = Date.now().toString(36);
    const randomPart = Math.random().toString(36).slice(2, 12);
    return `pot-baidu-tts-${timePart}-${randomPart}`.slice(0, 60);
}

// 把接口返回的音频数据统一转成 0-255 的普通数字数组。
// Pot 播放声音时执行 new Uint8Array(返回值).buffer，所以必须返回这种数组。
// 不同环境下数据可能是普通数组、ArrayBuffer 或 Uint8Array，全都要照顾到。
function toByteArray(data) {
    if (Array.isArray(data)) {
        // 套一层 Uint8Array.from 是为了把超出 0-255 的值截断到范围内。
        return Array.from(Uint8Array.from(data));
    }
    if (data instanceof ArrayBuffer) {
        return Array.from(new Uint8Array(data));
    }
    if (ArrayBuffer.isView(data)) {
        return Array.from(new Uint8Array(data.buffer, data.byteOffset, data.byteLength));
    }
    if (typeof data === "string") {
        return Array.from(new TextEncoder().encode(data));
    }
    throw "语音合成失败：接口没有返回可识别的音频数据";
}

// 把一串字节按 UTF-8 解码成文字。
function decodeUtf8(bytes) {
    return new TextDecoder("utf-8").decode(Uint8Array.from(bytes));
}

// 合成失败时百度返回的不是音频，而是一段 JSON 错误信息
// （比如 {"err_no": 502, "err_msg": "...", "sn": "..."}）。
// 因为请求时声明了要二进制，错误信息也是以字节的形式拿到的，
// 所以要先解码成文字再解析。不是错误 JSON 就返回 null，当作音频处理。
function parseTtsError(bytes) {
    const responseText = decodeUtf8(bytes).trim();
    if (!responseText.startsWith("{")) {
        return null;
    }

    try {
        const data = JSON.parse(responseText);
        if (data && typeof data === "object" && data.err_no !== undefined) {
            return data;
        }
    } catch (error) {
        return null;
    }
    return null;
}

// 把百度的错误编号翻译成人话。sn 是百度的请求流水号，
// 找百度排查问题时对方会要这个号，所以提示里保留。
function describeTtsError(data) {
    const errorNumber = Number(data.err_no);
    const errorDescriptions = {
        6: "当前账号没有语音合成权限",
        13: "请求频率超过 QPS 限制",
        15: "请求并发数超过限制",
        16: "文本字数超过接口限制",
        18: "语音合成集群并发数超过限制",
        500: "输入内容不受支持或请求超时",
        501: "输入参数不正确",
        502: "access_token 验证失败、已过期或调用额度已用尽",
        503: "合成服务处理失败，文本中可能含有非 GBK 字符",
        513: "文本中含有接口不支持的特殊符号",
    };
    const description = errorDescriptions[errorNumber]
        || data.err_msg
        || "百度语音合成接口返回未知错误";
    const serialNumber = data.sn === undefined || data.sn === null || data.sn === ""
        ? "未提供"
        : String(data.sn);
    // 501 大多是基础音库音量超限，提示里直接点明。
    const parameterHint = errorNumber === 501
        ? "。常见原因：基础音库（度小美/度小宇/度逍遥/度丫丫）的音量只支持 0-9，请调低音量或改用精品/臻品发音人。"
        : "";
    return `语音合成失败：${description}（err_no: ${data.err_no}；sn: ${serialNumber}）${parameterHint}`;
}

// 估算文本按 GBK 编码有多少字节。GBK 里英文数字这类 ASCII 字符占 1 字节，
// 中文等字符占 2 字节。用「字符编码是否小于 127」来区分，是粗略估算但够用。
// 百度限制文本必须小于 1024 字节，所以发请求前先自己检查一遍。
function estimateGbkByteLength(text) {
    let byteLength = 0;
    for (const character of text) {
        byteLength += character.codePointAt(0) <= 127 ? 1 : 2;
    }
    return byteLength;
}

// 调用百度的合成接口，成功时返回音频字节数组。
async function requestTts(text, accessToken, config, runtime) {
    // tex 只手动编码一次：Tauri 用表单提交时会自动再编一次，百度服务端解两次，正好抵消。
    // 编两次会多出一层，百度拿到 %E4%BD%A0 这种字面量，中文就被逐字念出来；不编则 +、% 会被解坏。
    // 表单项还只接受字符串，传数字整个请求会直接失败。
    const formBody = runtime.bodyFactory.form({
        tex: encodeURIComponent(text),
        tok: accessToken,
        cuid: createCuid(),
        ctp: "1",
        lan: "zh",
        spd: String(config.spd),
        pit: String(config.pit),
        vol: String(config.vol),
        per: String(config.per),
        aue: String(config.aue),
    });

    let response;
    try {
        response = await runtime.tauriFetch(TTS_URL, {
            method: "POST",
            headers: {
                "Content-Type": "application/x-www-form-urlencoded",
            },
            body: formBody,
            timeout: config.timeout,
            responseType: 3,
        });
    } catch (error) {
        throw describeNetworkFailure(error);
    }

    if (!isSuccessfulResponse(response)) {
        const status = response && response.status !== undefined ? response.status : "未知";
        throw `语音合成请求失败（HTTP 状态码：${status}）`;
    }

    // 音频和报错都以字节形式到手，先试着当报错解析，解析不出来就是音频。
    const audioBytes = toByteArray(response.data);
    const ttsError = parseTtsError(audioBytes);
    if (ttsError) {
        throw describeTtsError(ttsError);
    }
    if (audioBytes.length === 0) {
        throw "语音合成失败：接口返回了空音频";
    }
    return audioBytes;
}

// Pot 加载这个插件后，每次朗读文本就会调用这个函数。
// 成功：返回音频的字节数组，Pot 拿去播放。
// 失败：抛出一个字符串，Pot 会把它显示给用户，所以所有报错都必须是中文提示。
async function tts(text, lang, options = {}) {
    try {
        const inputText = text === undefined || text === null ? "" : String(text);
        if (inputText.trim().length === 0) {
            throw "待合成文本为空";
        }

        const estimatedLength = estimateGbkByteLength(inputText);
        if (estimatedLength >= 1024) {
            throw `待合成文本过长：估算的 GBK 编码长度为 ${estimatedLength} 字节，必须小于 1024 字节，请缩短文本后重试`;
        }

        // 百度的 zh 模式本身就能处理中英文混读，Pot 传来的语言代码用不上。
        const config = readConfig(options);
        const runtime = readRuntime(options);
        const accessToken = await fetchAccessToken(config, runtime.tauriFetch);
        return await requestTts(inputText, accessToken, config, runtime);
    } catch (error) {
        // 自己抛的字符串直接透传；其他意外错误包一层再抛，
        // 保证 Pot 拿到的永远是字符串。
        if (typeof error === "string") {
            throw error;
        }
        throw `百度语音合成失败：${getErrorMessage(error)}`;
    }
}
