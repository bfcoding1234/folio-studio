export const aiPmDefaults = {column:'AI 产品经理面试题',headerRight:'',title:'如何设计 Agent 的上下文？',question:'用户说客服答应过延期，但你查不到这条记录。你会先问什么？',bodySize:32,lineHeight:1.5,bodyFont:'sans',titleFont:'serif',theme:'clay',imageStyle:'ink',cover:true,ending:true,endingVote:false,coverImage:'/assets/context.png'};

// Standalone articles share the visual system, not the example article’s content.
export const quickAiPm = Object.freeze({...aiPmDefaults, title:'', coverImage:'', question:'这道题，你会怎么答？', endingLabel:'欢迎来答', endingInvite:'在评论区，写下你的判断。', endingSign:'本题完', endingActionNotes:Object.freeze(['下次练习，再来看看','给这道题一点反馈','一起练下一题'])});
export const cliPresets = Object.freeze({ text:Object.freeze({...quickAiPm, cover:false, ending:false}) });
