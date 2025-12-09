export const LOGO_URL = "https://i.imgur.com/example-logo.png"; 
export const WABO_LOGO_SVG = `
<svg viewBox="0 0 800 200" fill="none" xmlns="http://www.w3.org/2000/svg" class="h-full w-auto">
  <path d="M50 50 L80 150 L110 50 M120 50 L150 150 L180 50" stroke="#0099FF" stroke-width="15" stroke-linecap="round" stroke-linejoin="round"/>
  <text x="220" y="150" fill="#333" font-family="sans-serif" font-weight="bold" font-size="100">WABO</text>
  <text x="540" y="150" fill="#333" font-family="sans-serif" font-weight="bold" font-size="100">TECH</text>
</svg>
`;

export const WABO_LOGO_URL = "https://i.ibb.co/7jZXVXm/wabo-tech-logo.png"; 

// 阈值设置 - 参考 Matlab 逻辑
// 放松指数 (Relaxation) = Alpha / (Beta + Theta)
// 冥想状态阈值
export const MEDITATION_THRESHOLD = 0.85; 

// 采样设置
export const SAMPLING_RATE = 250;
export const UPDATE_INTERVAL_MS = 100; // UI 更新频率
export const HISTORY_LENGTH = 100; // 实时图表显示的点数

// 语言包配置
export const TRANSLATIONS = {
  zh: {
    title: "WABO Flow 脑电监测",
    device_status: "设备状态",
    connected: "已连接",
    disconnected: "未连接",
    connect_btn: "连接设备",
    disconnect_btn: "断开连接",
    start_btn: "开始监测",
    stop_btn: "停止监测",
    realtime_eeg: "实时脑电波 (uV)",
    meditation_state: "深度冥想",
    active_mind: "思维活跃",
    alpha_index: "Alpha 指数",
    target_achieved: "已进入目标状态",
    focus_breath: "请专注于呼吸",
    analysis_title: "脑波分析",
    relaxation_index: "放松指数",
    attention_index: "专注指数",
    alpha_desc: "Alpha (放松)",
    theta_desc: "Theta (困倦/潜意识)",
    beta_desc: "Beta (专注/紧张)",
    delta_desc: "Delta (深睡)",
    gamma_desc: "Gamma (认知)",
    simulate: "模拟模式",
    voice_feedback: "太棒了，你已经进入了冥想状态。",
  },
  en: {
    title: "WABO Flow EEG Monitor",
    device_status: "DEVICE STATUS",
    connected: "CONNECTED",
    disconnected: "DISCONNECTED",
    connect_btn: "Connect Device",
    disconnect_btn: "Disconnect",
    start_btn: "Start Monitoring",
    stop_btn: "Stop Monitoring",
    realtime_eeg: "Real-time EEG (uV)",
    meditation_state: "Deep Meditation",
    active_mind: "Active Mind",
    alpha_index: "ALPHA INDEX",
    target_achieved: "Target State Achieved",
    focus_breath: "Focus on your breath",
    analysis_title: "Brainwave Analysis",
    relaxation_index: "Relaxation Index",
    attention_index: "Attention Index",
    alpha_desc: "Alpha (Relaxation)",
    theta_desc: "Theta (Drowsiness)",
    beta_desc: "Beta (Focus/Stress)",
    delta_desc: "Delta",
    gamma_desc: "Gamma",
    simulate: "Simulate",
    voice_feedback: "Excellent. You have entered a meditation state.",
  }
};