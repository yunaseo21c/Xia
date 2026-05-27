const fs = require('fs');
const path = require('path');
const { USER_DATA_FILE } = require('./config');

/**
 * Loads a JSON file safely. Returns an empty object on error.
 * @param {string} filepath 
 * @returns {object}
 */
function load_json(filepath) {
  try {
    if (fs.existsSync(filepath)) {
      const content = fs.readFileSync(filepath, 'utf-8');
      return JSON.parse(content);
    }
  } catch (e) {
    console.error(`Error loading ${filepath}:`, e);
  }
  return {};
}

/**
 * Saves an object as formatted JSON.
 * @param {string} filepath 
 * @param {object} data 
 */
function save_json(filepath, data) {
  try {
    fs.writeFileSync(filepath, JSON.stringify(data, null, 4), 'utf-8');
  } catch (e) {
    console.error(`Error saving ${filepath}:`, e);
  }
}

/**
 * Serializes a Discord channel to a JSON-safe object.
 * @param {object} channel 
 * @returns {object}
 */
function serialize_channel(channel) {
  if (channel && channel.id) {
    return { id: channel.id.toString(), name: channel.name };
  }
  return {};
}

/**
 * Deserializes a Discord channel object back to a GuildChannel.
 * @param {object} data 
 * @param {object} guild 
 * @returns {object|null}
 */
function deserialize_channel(data, guild) {
  if (data && data.id && guild) {
    try {
      return guild.channels.cache.get(data.id) || null;
    } catch (e) {
      console.error("Error deserializing channel:", e);
    }
  }
  return null;
}

/**
 * Checks if a user has accepted the terms and conditions.
 * @param {string|number} user_id 
 * @returns {boolean}
 */
function is_registered(user_id) {
  const data = load_json(USER_DATA_FILE);
  return user_id.toString() in data;
}

/**
 * Checks if a member has administrative permissions (either standard Discord Admin or registered custom admin/role)
 * @param {object} member Discord.js GuildMember
 * @returns {Promise<boolean>}
 */
function checkAdminPermission(member) {
  return new Promise((resolve) => {
    if (!member || !member.guild) {
      resolve(false);
      return;
    }

    // 1. If the user has hardcoded Discord Administrator permission, they are always admin
    if (member.permissions.has('Administrator')) {
      resolve(true);
      return;
    }

    const sqlite3 = require('sqlite3').verbose();
    const dbPath = path.join(process.cwd(), 'xiadb.db');
    const db = new sqlite3.Database(dbPath);
    db.configure("busyTimeout", 5000);

    const guildId = member.guild.id.toString();
    const userId = member.user.id.toString();
    const roleIds = member.roles.cache.map(role => role.id.toString());

    // 2. Check if the user is individually registered
    db.get(
      "SELECT 1 FROM server_custom_admins WHERE guild_id = ? AND user_id = ?",
      [guildId, userId],
      (err, userRow) => {
        if (err) {
          console.error("Error checking custom admins:", err);
        }
        if (userRow) {
          db.close();
          resolve(true);
          return;
        }

        // 3. Check if any of the user's roles are registered
        if (roleIds.length === 0) {
          db.close();
          resolve(false);
          return;
        }

        const placeholders = roleIds.map(() => '?').join(',');
        db.get(
          `SELECT 1 FROM server_custom_admin_roles WHERE guild_id = ? AND role_id IN (${placeholders})`,
          [guildId, ...roleIds],
          (err, roleRow) => {
            if (err) {
              console.error("Error checking custom admin roles:", err);
            }
            db.close();
            resolve(!!roleRow);
          }
        );
      }
    );
  });
}

/**
 * Generates the next sequential warning ID for a specific guild, ensuring
 * that even if previous warnings are deleted, the ID does not reset to 1 or duplicate.
 * @param {object} db sqlite3.Database instance
 * @param {string|number} guildId 
 * @returns {Promise<number>}
 */
function getNextWarnId(db, guildId) {
  return new Promise((resolve, reject) => {
    db.serialize(() => {
      db.run("INSERT OR IGNORE INTO warning_sequences (guild_id, last_warn_id) VALUES (?, 0)", [guildId.toString()]);
      db.run("UPDATE warning_sequences SET last_warn_id = last_warn_id + 1 WHERE guild_id = ?", [guildId.toString()]);
      db.get("SELECT last_warn_id FROM warning_sequences WHERE guild_id = ?", [guildId.toString()], (err, row) => {
        if (err) return reject(err);
        resolve(row ? row.last_warn_id : 1);
      });
    });
  });
}

/**
 * 자연어 또는 슬래시 명령어로 입력받은 쿼리나 사유 문자열에서
 * 불필요한 행위 동사나 접사(예: "사유로 지급", "사유로 처리", "부여" 등)를 제거하고
 * 오직 순수한 사유만을 정제하여 추출하는 헬퍼 함수
 * @param {string} query 
 * @param {string} actionType 'warn' | 'subtract'
 * @returns {string} 정제된 사유
 */
function extractNaturalReason(query, actionType = 'warn') {
  if (!query) return "사유 미지정";
  
  // 1. 멘션 제거
  let text = query.replace(/<@!?\d+>/g, '').trim();

  // 2. 숫자 및 단위 제거 (예: 1회, 2번, 5개, 1시간, 10분 등)
  text = text.replace(/\d+\s*(?:회|번|개|id|번째|일|시간|분|초)/g, '').trim();
  text = text.replace(/\b\d{1,2}\b/g, '').trim();

  // 3. 명령어 핵심 키워드 제거 (모든 모더레이션 명령어와 지시동사 일괄 필터링)
  text = text.replace(/경고|부여|설정|적용|삭제|차감|제거|지워|취소|초기화|타임아웃|뮤트|음소거|차단|밴|영구|추방|킥|강퇴|해제|풀어|풀기/g, '').trim();

  // 종결어미 및 불필요 접사 제거 (단어 끝부분 위주)
  // 지급해줘, 부여해줘 등 더 길고 구체적인 어휘들을 앞에 배치하여 우선 매치되도록 수정!
  text = text.replace(/(?:지급해줘|부여해줘|적용해줘|처리해줘|등록해줘|해줘|해볼까요|할게요|할게|해주라|해주세요|해라|줄래|지급|부여|적용|처리|등록)$/, '').trim();

  // 4. 사유 패턴 매칭 진행
  
  // A. 접두사 패턴: "사유: 도배", "사유는 욕설", "이유 도배" 등
  const prefixPattern = /^(?:사유|이유)(?:\s*:\s*|\s+는\s+|\s+은\s+|\s+)(.+)$/;
  const prefixMatch = text.match(prefixPattern);
  if (prefixMatch && prefixMatch[1].trim()) {
    return prefixMatch[1].trim();
  }

  // B. 접미사 패턴: "도배 사유로", "욕설 사유 때문에", "도배 사유" 등
  const suffixPattern = /^(.*?)\s*(?:사유로|사유\s*때문에|사유)$/;
  const suffixMatch = text.match(suffixPattern);
  if (suffixMatch && suffixMatch[1].trim()) {
    return suffixMatch[1].trim();
  }

  // C. 이유/조사 패턴: "도배 때문에", "실수로", "도배로" 등
  const becausePattern = /^(.*?)\s*(?:때문에|으로|로)$/;
  const becauseMatch = text.match(becausePattern);
  if (becauseMatch && becauseMatch[1].trim()) {
    const res = becauseMatch[1].trim();
    // "경고로" 처럼 키워드 자체가 필터링되지 않고 유입된 경우는 무시
    if (res.length > 0 && !/^(?:경고|삭제|차감|제거)$/.test(res)) {
      return res;
    }
  }

  // D. 문장 중간 또는 어디선가 "사유: 도배" 가 매칭되는 경우
  const inlinePattern = /(?:사유|이유)(?:\s*:\s*|\s+는\s+|\s+은\s+|\s+)(.+)/;
  const inlineMatch = text.match(inlinePattern);
  if (inlineMatch && inlineMatch[1].trim()) {
    return inlineMatch[1].trim();
  }

  // E. 남은 텍스트 전체를 사유로 간주 (단, 핵심 기능 키워드만 덜렁 남은 경우는 무시)
  const cleanStr = text.replace(/[^a-zA-Z0-9가-힣\s]/g, '').trim();
  if (cleanStr.length > 0 && !/^(?:해줘|해|줘|줄래|적용|설정|지급|부여|처리|등록)$/.test(cleanStr)) {
    return text;
  }

  return "사유 미지정";
}

module.exports = {
  load_json,
  save_json,
  serialize_channel,
  deserialize_channel,
  is_registered,
  checkAdminPermission,
  getNextWarnId,
  extractNaturalReason
};

