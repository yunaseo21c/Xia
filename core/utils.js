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

module.exports = {
  load_json,
  save_json,
  serialize_channel,
  deserialize_channel,
  is_registered,
  checkAdminPermission
};
