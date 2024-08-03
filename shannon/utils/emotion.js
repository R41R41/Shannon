function getEmotionParameters(emotion) {
    // デフォルト値の設定
    let happy = 0, sad = 0, angry = 0, fun = 0;
    let pitch = 100, speed = 100;

    // 感情に基づいてパラメータを調整
    switch (emotion) {
        case '嫌悪':
            angry = 80; sad = 50; pitch = -150; speed = 80;
            break;
        case '期待':
            fun = 100; pitch = -50;
            break;
        case '羞恥':
            sad = 50; speed = 75;
            break;
        case '怒り':
            angry = 100; pitch = -50; speed = 125;
            break;
        case '悲観':
            sad = 100; pitch = -100;
            break;
        case '楽観':
            happy = 100;
            break;
        case '冷静':
            pitch = -50;
            break;
        case '幸せ':
            happy = 100; fun = 25; pitch = -50;
            break;
        default:
        // デフォルト値のまま
    }

    return { happy, sad, angry, fun, pitch, speed };
}

module.exports = {
    getEmotionParameters
};