
export const WABO_LOGO_URL = "https://i.ibb.co/7jZXVXm/wabo-tech-logo.png"; 

// 冥想判定逻辑：Alpha 能量占比
export const MEDITATION_THRESHOLD = 0.55; 

// 采样设置
export const SAMPLING_RATE = 250;
export const UPDATE_INTERVAL_MS = 100; // UI 更新频率
export const HISTORY_LENGTH = 120; // 实时图表显示的点数

// 语言包配置 - 增强语音引导的情感化设计
export const TRANSLATIONS = {
  zh: {
    title: "WABO Flow 冥想监测",
    device_status: "连接状态",
    connected: "已在线",
    disconnected: "离线",
    connect_btn: "开启心流",
    disconnect_btn: "结束会话",
    start_btn: "开始练习",
    stop_btn: "停止",
    realtime_eeg: "脑电节律 (uV)",
    meditation_state: "深层禅定",
    active_mind: "思维流转",
    alpha_index: "Alpha 强度",
    target_achieved: "身心已归于宁静",
    focus_breath: "觉察呼吸，感受当下",
    analysis_title: "多维频段分析",
    relaxation_index: "宁静指数",
    attention_index: "专注指数",
    alpha_desc: "Alpha (放松/创意)",
    theta_desc: "Theta (潜意识/入定)",
    beta_desc: "Beta (逻辑/焦虑)",
    delta_desc: "Delta (修复)",
    gamma_desc: "Gamma (高认知)",
    simulate: "体感模拟",
    // 冥想引导语 (由温婉女声播报)
    voice_welcome: "你好。请找一个舒服的姿势坐好。闭上眼，我们开始吧。",
    voice_meditating: "做得很好。感受那种宁静的力量，正在你的识海中蔓延。",
    voice_distracted: "察觉到你的思绪在飘走吗？没关系，轻轻地把注意力带回呼吸上。",
    voice_deep: "非常棒，你已经进入了深层心流。继续保持这种觉知。",
    simulation_hint: "平放手机进入冥想，晃动模拟波动",
  },
  en: {
    title: "WABO Flow Zen Monitor",
    device_status: "STATUS",
    connected: "CONNECTED",
    disconnected: "DISCONNECTED",
    connect_btn: "Begin Flow",
    disconnect_btn: "End Session",
    start_btn: "Start",
    stop_btn: "Stop",
    realtime_eeg: "EEG Rhythm (uV)",
    meditation_state: "Deep Zen",
    active_mind: "Active Mind",
    alpha_index: "ALPHA POWER",
    target_achieved: "Mind and Body in Harmony",
    focus_breath: "Observe your breath",
    analysis_title: "Spectral Analysis",
    relaxation_index: "Zen Index",
    attention_index: "Focus Index",
    alpha_desc: "Alpha (Relax)",
    theta_desc: "Theta (Subconscious)",
    beta_desc: "Beta (Active)",
    delta_desc: "Delta",
    gamma_desc: "Gamma",
    simulate: "Motion Sim",
    voice_welcome: "Welcome. Find a comfortable position. Close your eyes, and let's begin.",
    voice_meditating: "Beautiful. Feel the tranquility spreading through your mind.",
    voice_distracted: "Is your mind wandering? It's okay. Gently bring your focus back to your breath.",
    voice_deep: "Excellent. You are in a state of deep flow. Maintain this awareness.",
    simulation_hint: "Keep device still to meditate.",
  }
};
