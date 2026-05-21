// Comprehensive list of common Korean profanity/bad words
const swearWords = [
  '개새끼', '개세끼', '개섹기', '개쉑', '개쉐', '개색기', '개새',
  '씨발', '시발', '씨이발', '시이발', '씨바', '시바', '씨발놈', '씨발년', '씹할', '씌발', '쓔발',
  '병신', '빙신', '뵹신', '병쉰', '빙쉰',
  '좆', '좃', '조까', '좆까', '개좆', '존나', '존나게', '졸라', '좃나', '좃까',
  '지랄', '쥐랄', '지럴',
  '엠창', '느금마', '느검마', '니기미', '니앰미', '니엠창',
  '썅', '썅년', '썅놈',
  '미친년', '미친놈', '미친새끼',
  '씹', '보지', '자지', '잠지', '씹년', '씹놈', '씹새끼', '씹창',
  '아가리', '주둥이', '닥쳐', '닥치고',
  '호로', '호로새끼', '호로자식',
  '옘병', '염병',
  '등신', '호구', '빡대가리', '머저리'
];

/**
 * Checks if a string contains Korean profanity.
 * Strips out spacing and special characters/numbers to prevent bypass attempts.
 * @param {string} content 
 * @returns {boolean}
 */
function check(content) {
  if (!content || typeof content !== 'string') return false;
  
  // 1. Direct check
  const lowerContent = content.toLowerCase();
  for (const word of swearWords) {
    if (lowerContent.includes(word)) {
      return true;
    }
  }

  // 2. Obfuscation bypass check (remove spaces, symbols, and numbers)
  const normalized = lowerContent.replace(/[\s\d\~\!\@\#\$\%\^\&\*\(\)\_\+\-\=\[\]\{\}\;\:\'\"\,\<\.\>\/\?\\\|]/g, '');
  for (const word of swearWords) {
    if (normalized.includes(word)) {
      return true;
    }
  }

  return false;
}

module.exports = {
  check
};
