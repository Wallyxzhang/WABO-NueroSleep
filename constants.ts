
export const WABO_LOGO_URL = "https://i.ibb.co/7jZXVXm/wabo-tech-logo.png"; 

// 采样设置
export const SAMPLING_RATE = 250;
export const UPDATE_INTERVAL_MS = 100; // UI 更新频率
export const HISTORY_LENGTH = 120; // 实时图表显示的点数

// 冥想算法配置
export const MEDITATION_THRESHOLD = 0.65; // 降低初始门槛，让用户更容易获得激励
export const ALPHA_BETA_RATIO_WEIGHT = 1.5; // 增加 Alpha 的权重

// 语言包配置
export const TRANSLATIONS = {
  zh: {
    title: "WABO Flow 深度冥想",
    device_status: "设备状态",
    connected: "已连接",
    disconnected: "未连接",
    connect_btn: "连接设备",
    disconnect_btn: "断开连接",
    start_btn: "开始冥想",
    stop_btn: "结束练习",
    realtime_eeg: "脑电电压 (uV)",
    meditation_state: "深层入定",
    active_mind: "思绪活跃",
    alpha_index: "Alpha 强度",
    target_achieved: "状态极佳，保持这份宁静",
    focus_breath: "放松双肩，感受呼吸",
    analysis_title: "脑波状态分析",
    relaxation_index: "放松指数",
    attention_index: "专注指数",
    alpha_desc: "Alpha (放松/创意)",
    theta_desc: "Theta (潜意识)",
    beta_desc: "Beta (逻辑/焦虑)",
    delta_desc: "Delta",
    gamma_desc: "Gamma",
    simulate: "模拟模式",
    voice_welcome: "欢迎使用 WABO 深度冥想。请微闭双眼，专注于你的呼吸。",
    voice_feedback_good: "太棒了，你已经进入了深度放松状态。",
    voice_feedback_keep: "做得很好，继续保持这种宁静。",
    voice_distracted: "感受到思绪飘散了吗？轻轻地把注意力带回呼吸上。",
    simulation_hint: "保持平放以模拟放松，晃动手机模拟走神",
  },
  en: {
    title: "WABO Flow Deep Flow",
    device_status: "STATUS",
    connected: "CONNECTED",
    disconnected: "DISCONNECTED",
    connect_btn: "Connect",
    disconnect_btn: "Disconnect",
    start_btn: "Start Flow",
    stop_btn: "Stop",
    realtime_eeg: "EEG (uV)",
    meditation_state: "Deep Flow",
    active_mind: "Monkey Mind",
    alpha_index: "ALPHA POWER",
    target_achieved: "Perfect harmony, stay here",
    focus_breath: "Relax your shoulders, follow the breath",
    analysis_title: "Brainwave Metrics",
    relaxation_index: "Relaxation",
    attention_index: "Focus",
    alpha_desc: "Alpha (Relax)",
    theta_desc: "Theta (Drowsy)",
    beta_desc: "Beta (Alert)",
    delta_desc: "Delta",
    gamma_desc: "Gamma",
    simulate: "Sim Mode",
    voice_welcome: "Welcome to WABO Flow. Close your eyes and follow your breath.",
    voice_feedback_good: "Excellent. You are entering deep relaxation.",
    voice_feedback_keep: "Very well. Stay in this peace.",
    voice_distracted: "Noticed your mind wandering? Gently return to your breath.",
    simulation_hint: "Keep still to meditate, shake to disrupt.",
  }
};
