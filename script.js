window.va = window.va || function () {
  (window.vaq = window.vaq || []).push(arguments);
};

const SUPABASE_URL = "https://jqxldhimffsafkjghguy.supabase.co";
    const SUPABASE_KEY = "sb_publishable_5m7EfZach86cPfe7ZUXCFA_3PhFe-JQ";

    const supabaseClient = supabase.createClient(
      SUPABASE_URL,
      SUPABASE_KEY
    );


    let currentUser = null;

    // Username-only public authentication.
    // Supabase Password Auth still expects an email-shaped identifier internally,
    // so we deterministically map each username to a private synthetic identifier.
    const VISION_AUTH_DOMAIN = "auth.thevision.game";

    function normalizeUsername(value) {
      return String(value || "").trim().toLowerCase();
    }

    function validUsername(username) {
      return /^[a-z0-9_]{3,20}$/.test(username);
    }

    function authIdentifierForUsername(username) {
      return `${normalizeUsername(username)}@${VISION_AUTH_DOMAIN}`;
    }

    async function usernameIsAvailable(username) {
      const { data, error } = await supabaseClient.rpc(
        "is_username_available",
        { requested_username: normalizeUsername(username) }
      );
      if (error) throw error;
      return data === true;
    }

    async function saveUsernameProfile(user, username) {
      const normalized = normalizeUsername(username);
      const { error } = await supabaseClient
        .from("profiles")
        .upsert(
          { id: user.id, username: normalized },
          { onConflict: "id" }
        );
      if (error) throw error;
    }

    function playAsGuest() {
      // Guest mode is intentionally one completed run only. Starting another
      // guest run after a completed career clears the previous guest record.
      if (localStorage.getItem(GUEST_RUN_COMPLETED_KEY) === "1") {
        resetGuestRunStorage();
      } else {
        loadGuestStorage();
      }

      guestMode = true;
      currentUser = null;
      pendingGuestMigration = false;
      document.getElementById("status").textContent = "Guest";
      document.getElementById("authMessage").textContent = "";
      showMainMenu();
    }

    function saveGuestCareer() {
      pendingGuestMigration = true;
      guestMode = true;
      document.getElementById("status").textContent = "Create Account";
      show("auth");
      const message = document.getElementById("authMessage");
      message.textContent = "Create an account or login to save this guest career and scouting record.";
      window.scrollTo({ top: 0, behavior: "smooth" });
    }

    async function migrateGuestDataToAccount() {
      if (!currentUser || !pendingGuestMigration) return;

      // Keep guest career numbers from colliding with existing account careers.
      let careerOffset = 0;
      const { data: existingCareers, error: careerReadError } = await supabaseClient
        .from("career_history")
        .select("career_number")
        .eq("user_id", currentUser.id)
        .order("career_number", { ascending: false })
        .limit(1);

      if (!careerReadError && existingCareers?.length) {
        careerOffset = Number(existingCareers[0].career_number) || 0;
      }

      // Merge guest collection counts with any collection the account already owns.
      const guestPlayerIds = Object.keys(guestCollection).map(Number).filter(Number.isFinite);
      let existingCollection = [];

      if (guestPlayerIds.length) {
        const { data, error } = await supabaseClient
          .from("player_collection")
          .select("*")
          .eq("user_id", currentUser.id)
          .in("player_id", guestPlayerIds);

        if (error) {
          console.error("Existing collection lookup failed:", error);
        } else {
          existingCollection = data || [];
        }
      }

      const existingById = new Map(
        existingCollection.map(row => [String(row.player_id), row])
      );

      const collectionRows = Object.entries(guestCollection).map(([playerId, item]) => {
        const existing = existingById.get(String(playerId));
        const guestCount = Number(item.times_discovered || 1);
        const existingCount = Number(existing?.times_discovered || 0);

        return {
          user_id: currentUser.id,
          player_id: Number(playerId),
          first_career: existing?.first_career ?? (item.first_career ? Number(item.first_career) + careerOffset : null),
          first_season: existing?.first_season ?? item.first_season ?? null,
          times_discovered: existingCount + guestCount,
          last_career: item.last_career ? Number(item.last_career) + careerOffset : existing?.last_career ?? null,
          last_season: item.last_season ?? existing?.last_season ?? null
        };
      });

      if (collectionRows.length) {
        const { error } = await supabaseClient
          .from("player_collection")
          .upsert(collectionRows, { onConflict: "user_id,player_id" });
        if (error) console.error("Guest collection migration failed:", error);
      }

      if (guestDiscoveries.length) {
        const rows = guestDiscoveries.map(d => ({
          user_id: currentUser.id,
          player_id: Number(d.player_id),
          career_number: Number(d.career_number || 0) + careerOffset,
          season: d.season,
          game: d.game || null,
          ovr: Number.isFinite(Number(d.ovr)) ? Number(d.ovr) : null,
          age: Number.isFinite(Number(d.age)) ? Number(d.age) : null,
          position: d.position || null
        }));

        const { error } = await supabaseClient
          .from("player_discoveries")
          .insert(rows);
        if (error) console.error("Guest discovery migration failed:", error);
      }

      if (Object.keys(guestSignings).length) {
        const signingRows = Object.values(guestSignings).map(item => ({
          user_id: currentUser.id,
          player_id: Number(item.player_id),
          first_career: item.first_career ? Number(item.first_career) + careerOffset : null,
          first_season: item.first_season || null,
          times_signed: Number(item.times_signed || 1),
          last_career: item.last_career ? Number(item.last_career) + careerOffset : null,
          last_season: item.last_season || null
        }));

        const { data: existingSignings, error: signingReadError } = await supabaseClient
          .from("player_signings")
          .select("*")
          .eq("user_id", currentUser.id)
          .in("player_id", signingRows.map(r => r.player_id));

        if (signingReadError) {
          console.error("Existing signing lookup failed:", signingReadError);
        } else {
          const existingById = new Map((existingSignings || []).map(r => [String(r.player_id), r]));
          const merged = signingRows.map(r => {
            const existing = existingById.get(String(r.player_id));
            return {
              ...r,
              first_career: existing?.first_career ?? r.first_career,
              first_season: existing?.first_season ?? r.first_season,
              times_signed: Number(existing?.times_signed || 0) + Number(r.times_signed || 0),
              last_career: r.last_career ?? existing?.last_career,
              last_season: r.last_season ?? existing?.last_season
            };
          });
          const { error } = await supabaseClient
            .from("player_signings")
            .upsert(merged, { onConflict: "user_id,player_id" });
          if (error) console.error("Guest signing migration failed:", error);
        }
      }

      if (guestCareers.length) {
        const rows = guestCareers.map(c => ({
          user_id: currentUser.id,
          career_number: Number(c.career_number) + careerOffset,
          team_name: c.team_name || "The Vision FC",
          formation: c.formation || null,
          final_ovr: Number.isFinite(Number(c.final_ovr)) ? Number(c.final_ovr) : null,
          league_titles: Number(c.league_titles || 0),
          ucl_titles: Number(c.ucl_titles || 0),
          best_position: Number.isFinite(Number(c.best_position)) ? Number(c.best_position) : null,
          worst_position: Number.isFinite(Number(c.worst_position)) ? Number(c.worst_position) : null,
          players_scouted: Number(c.players_scouted || 0),
          unique_players_discovered: Number(c.unique_players_discovered || 0)
        }));

        const { error } = await supabaseClient
          .from("career_history")
          .upsert(rows, { onConflict: "user_id,career_number" });
        if (error) console.error("Guest career migration failed:", error);
      }

      pendingGuestMigration = false;
      guestMode = false;
      localStorage.removeItem(GUEST_COLLECTION_KEY);
      localStorage.removeItem(GUEST_DISCOVERIES_KEY);
      localStorage.removeItem(GUEST_SIGNINGS_KEY);
      localStorage.removeItem(GUEST_CAREERS_KEY);
      localStorage.removeItem(GUEST_CAREER_COUNT_KEY);
      localStorage.removeItem(GUEST_RUN_COMPLETED_KEY);
      guestCollection = {};
      guestDiscoveries = [];
      guestSignings = {};
      guestCareers = [];
    }

    async function register() {
      const username = normalizeUsername(document.getElementById("authUsername").value);
      const password = document.getElementById("authPassword").value;
      const message = document.getElementById("authMessage");

      if (!validUsername(username)) {
        message.textContent = "Username must be 3-20 characters using only letters, numbers, or _.";
        return;
      }

      if (password.length < 8) {
        message.textContent = "Password must be at least 8 characters.";
        return;
      }

      try {
        if (!(await usernameIsAvailable(username))) {
          message.textContent = "That username is already taken.";
          return;
        }

        const { data, error } = await supabaseClient.auth.signUp({
          email: authIdentifierForUsername(username),
          password,
          options: {
            data: { username }
          }
        });

        if (error) throw error;

        if (!data.session) {
          message.textContent =
            "Account created, but Supabase email confirmation is enabled. Disable 'Confirm email' in Authentication → Providers → Email, then try again.";
          return;
        }

        currentUser = data.session.user;
        await saveUsernameProfile(currentUser, username);
        await migrateGuestDataToAccount();
        message.textContent = "";
        await showMainMenu();
      } catch (error) {
        console.error("Registration failed:", error);
        message.textContent = error.message || "Could not create account.";
      }
    }

    async function login() {
      const username = normalizeUsername(document.getElementById("authUsername").value);
      const password = document.getElementById("authPassword").value;
      const message = document.getElementById("authMessage");

      if (!validUsername(username)) {
        message.textContent = "Enter a valid username.";
        return;
      }

      if (!password) {
        message.textContent = "Enter your password.";
        return;
      }

      const { data, error } = await supabaseClient.auth.signInWithPassword({
        email: authIdentifierForUsername(username),
        password
      });

      if (error) {
        console.error(error);
        message.textContent = "Incorrect username or password.";
        return;
      }

      currentUser = data.user;

      try {
        await saveUsernameProfile(currentUser, username);
      } catch (profileError) {
        console.error("Could not save username profile:", profileError);
      }

      await migrateGuestDataToAccount();
      message.textContent = "";
      await showMainMenu();
    }

    async function showMainMenu() {
      if (!currentUser && !guestMode) {
        show("auth");
        return;
      }

      if (currentUser) {
        await loadAchievements();
        await loadUserAchievements();
      }

      const welcome = document.getElementById("welcomeMessage");

      if (currentUser) {
        let username = "Manager";
        const { data, error } = await supabaseClient
          .from("profiles")
          .select("username")
          .eq("id", currentUser.id)
          .single();

        if (!error && data && data.username) username = data.username;
        welcome.textContent = `Welcome back, ${username}!`;
        document.getElementById("menuAccountButton").textContent = "Logout";
        document.getElementById("status").textContent = "Home";
      } else {
        welcome.textContent = "Guest mode · your scouting record is saved on this device.";
        document.getElementById("menuAccountButton").textContent = "Exit Guest";
        document.getElementById("status").textContent = "Guest";
      }

      show("menu");
    }

    function showCareerSetup() {
      show("careerSetup");
      document.getElementById("status").textContent = "New Career";
    }

    async function checkAuth() {
      const { data, error } =
        await supabaseClient.auth.getSession();

      if (error) {
        console.error(error);
        return;
      }

      if (data.session) {
        currentUser = data.session.user;
        showMainMenu();
      } else {
        show("auth");
      }
    }

    async function logout() {
      if (guestMode && !currentUser) {
        guestMode = false;
        document.getElementById("status").textContent = "Ready";
        show("auth");
        return;
      }

      const { error } = await supabaseClient.auth.signOut();

      if (error) {
        console.error(error);
        return;
      }

      currentUser = null;
      guestMode = false;
      document.getElementById("status").textContent = "Ready";
      show("auth");
    }

    async function loadAchievements() {

      const { data, error } = await supabaseClient
        .from("achievements")
        .select("*")
        .order("category")
        .order("name");

      if (error) {
        console.error("Failed to load achievements:", error);
        return;
      }

      achievementDefinitions = data || [];
    }

    async function loadUserAchievements() {

      if (!currentUser) return;

      const { data, error } = await supabaseClient
        .from("user_achievements")
        .select("achievement_id")
        .eq("user_id", currentUser.id);

      if (error) {
        console.error("Failed to load user achievements:", error);
        return;
      }

      unlockedAchievements = new Set(
        (data || []).map(row => row.achievement_id)
      );
    }

    const seasons = [
      ["2014/2015", "FIFA 16", "160058"], ["2015/2016", "FIFA 17", "170099"], ["2016/2017", "FIFA 18", "180084"],
      ["2017/2018", "FIFA 19", "190075"], ["2018/2019", "FIFA 20", "200061"], ["2019/2020", "FIFA 21", "210064"],
      ["2020/2021", "FIFA 22", "220069"], ["2021/2022", "FIFA 23", "230054"], ["2022/2023", "FC 24", "240050"],
      ["2023/2024", "FC 25", "250044"], ["2024/2025", "FC 26", "260006"], ["2025/2026", "FC 27", "270002"]
    ];

    const SEASON_COUNT = seasons.length;
    const FINAL_SEASON_INDEX = SEASON_COUNT - 1;

    // Some SoFIFA exports use a different FC 27 version suffix.
    // Prefer the configured version, but fall back to any matching 27xxxx key.
    function resolveHistoryVersion(history, version) {
      if (!history) return version;
      if (Object.prototype.hasOwnProperty.call(history, version)) return version;
      if (String(version).startsWith("270")) {
        const fallback = Object.keys(history).find(k => String(k).startsWith("270"));
        if (fallback) return fallback;
      }
      return version;
    }

    function getHistoryValue(history, version) {
      if (!history) return undefined;
      const key = resolveHistoryVersion(history, version);
      return history[key];
    }

    const formations = {
      433: [["GK", 50, 91], ["LB", 20, 76], ["CB", 40, 82], ["CB", 60, 82], ["RB", 80, 76], ["CM", 35, 53], ["CDM", 50, 59], ["CM", 65, 53], ["LW", 20, 31], ["ST", 50, 25], ["RW", 80, 31]],
      442: [["GK", 50, 91], ["LB", 20, 76], ["CB", 40, 82], ["CB", 60, 82], ["RB", 80, 76], ["LM", 18, 56], ["CM", 40, 56], ["CM", 60, 56], ["RM", 82, 56], ["ST", 40, 28], ["ST", 60, 28]],
      4231: [["GK", 50, 91], ["LB", 20, 76], ["CB", 40, 82], ["CB", 60, 82], ["RB", 80, 76], ["CDM", 40, 59], ["CDM", 60, 59], ["LW", 20, 40], ["CAM", 50, 43], ["RW", 80, 40], ["ST", 50, 27]],
      352: [["GK", 50, 91], ["CB", 30, 76], ["CB", 50, 76], ["CB", 70, 76], ["LM", 15, 51], ["CDM", 35, 62], ["CDM", 65, 62], ["RM", 85, 51], ["CAM", 50, 50], ["ST", 40, 25], ["ST", 60, 25]],
      343: [["GK", 50, 91], ["CB", 30, 76], ["CB", 50, 76], ["CB", 70, 76], ["LM", 17, 55], ["CM", 38, 56], ["CM", 62, 56], ["RM", 83, 55], ["LW", 20, 32], ["ST", 50, 26], ["RW", 80, 32]],
      532: [["GK", 50, 91], ["LB", 12, 73], ["CB", 34, 79], ["CB", 50, 79], ["CB", 66, 79], ["RB", 88, 73], ["CM", 35, 58], ["CDM", 50, 52], ["CM", 65, 58], ["ST", 40, 28], ["ST", 60, 28]]
    };

    const interchangeable = [
      new Set(["LB", "LWB"]),
      new Set(["RB", "RWB"]),
      new Set(["ST", "CF"]),
    ];

    function getEffectiveOvr(playerOvr, playerPos, slotLabel) {
      let ovr = Number(playerOvr) || 0;
      if (!playerPos || !slotLabel) return ovr;
      if (playerPos === slotLabel) return ovr;

      if (playerPos === "GK" && slotLabel !== "GK") return 0;
      if (playerPos !== "GK" && slotLabel === "GK") return 0;

      for (let s of interchangeable) {
        if (s.has(playerPos) && s.has(slotLabel)) {
          return ovr;
        }
      }
      return ovr - 5;
    }


    let pools = null, allPlayers = null, selections = [], used = new Set(), options = [], chosen = null, round = 0, placements = {};
    let budget = 250000000;
    let plData = {};
    let uclData = {};
    let seasonResults = [];
    let achievementDefinitions = [];
    let unlockedAchievements = new Set();

    // Account / guest progression.
    let guestMode = false;
    let pendingGuestMigration = false;
    let careerNumber = 0;
    let careerSaved = false;
    let careerDiscoveryIds = new Set();
    let careerDiscoveryCount = 0;
    let guestCollection = {};
    let guestDiscoveries = [];
    let guestSignings = {};
    let guestCareers = [];
    let scoutingRecordPage = 1;
    let scoutingRecordFilter = "all";
    const SCOUTING_RECORD_PAGE_SIZE = 30;

    const GUEST_COLLECTION_KEY = "the_vision_guest_collection_v1";
    const GUEST_DISCOVERIES_KEY = "the_vision_guest_discoveries_v1";
    const GUEST_SIGNINGS_KEY = "the_vision_guest_signings_v1";
    const GUEST_CAREERS_KEY = "the_vision_guest_careers_v1";
    const GUEST_CAREER_COUNT_KEY = "the_vision_guest_career_count_v1";
    const GUEST_RUN_COMPLETED_KEY = "the_vision_guest_run_completed_v1";

    function resetGuestRunStorage() {
      localStorage.removeItem(GUEST_COLLECTION_KEY);
      localStorage.removeItem(GUEST_DISCOVERIES_KEY);
      localStorage.removeItem(GUEST_SIGNINGS_KEY);
      localStorage.removeItem(GUEST_CAREERS_KEY);
      localStorage.removeItem(GUEST_CAREER_COUNT_KEY);
      localStorage.removeItem(GUEST_RUN_COMPLETED_KEY);

      guestCollection = {};
      guestDiscoveries = [];
      guestSignings = {};
      guestCareers = [];
    }

    function loadGuestStorage() {
      try {
        guestCollection = JSON.parse(localStorage.getItem(GUEST_COLLECTION_KEY) || "{}") || {};
        guestDiscoveries = JSON.parse(localStorage.getItem(GUEST_DISCOVERIES_KEY) || "[]") || [];
        guestSignings = JSON.parse(localStorage.getItem(GUEST_SIGNINGS_KEY) || "{}") || {};
        guestCareers = JSON.parse(localStorage.getItem(GUEST_CAREERS_KEY) || "[]") || [];

        // A guest is allowed exactly one completed career. If an older version
        // left completed guest data behind, treat it as a completed run too so
        // the next guest session starts clean.
        if (guestCareers.length > 0) {
          localStorage.setItem(GUEST_RUN_COMPLETED_KEY, "1");
        }
      } catch (e) {
        console.warn("Guest storage could not be loaded:", e);
        guestCollection = {};
        guestDiscoveries = [];
        guestSignings = {};
        guestCareers = [];
      }
    }

    function saveGuestStorage() {
      try {
        localStorage.setItem(GUEST_COLLECTION_KEY, JSON.stringify(guestCollection));
        localStorage.setItem(GUEST_DISCOVERIES_KEY, JSON.stringify(guestDiscoveries));
        localStorage.setItem(GUEST_SIGNINGS_KEY, JSON.stringify(guestSignings));
        localStorage.setItem(GUEST_CAREERS_KEY, JSON.stringify(guestCareers));
      } catch (e) {
        console.warn("Guest storage could not be saved:", e);
      }
    }

    loadGuestStorage();

    function parseValue(valStr) {
      if (!valStr || typeof valStr !== 'string') return 0;
      let num = parseFloat(valStr.replace(/[^0-9.]/g, ''));
      if (valStr.includes('M')) return num * 1000000;
      if (valStr.includes('K')) return num * 1000;
      return num;
    }
    function formatMoney(num) {
      if (num >= 1000000) return "€" + (num / 1000000).toFixed(1) + "M";
      if (num >= 1000) return "€" + (num / 1000).toFixed(0) + "K";
      return "€" + num;
    }
    // Players encountered during a career get a unique random two-letter identity code.
    // Codes are assigned lazily so the two-letter space is never exhausted by
    // players who are never shown. Real names are only shown on the final reveal.
    let playerCodeMap = new Map();
    let usedPlayerCodes = new Set();

    function randomTwoLetterCode() {
      const letters = "ABCDEFGHIJKLMNOPQRSTUVWXYZ";
      let code;
      do {
        code =
          letters[Math.floor(Math.random() * letters.length)] +
          letters[Math.floor(Math.random() * letters.length)];
      } while (usedPlayerCodes.has(code) && usedPlayerCodes.size < 676);

      usedPlayerCodes.add(code);
      return code;
    }

    function playerIdentityKey(p) {
      if (!p) return null;
      if (p.player_id != null) return String(p.player_id);
      if (p.id != null) return String(p.id);
      if (p.name) return `name:${p.name}`;
      return null;
    }

    function assignPlayerCode(p) {
      if (!p) return "??";

      const key = playerIdentityKey(p);
      if (key && playerCodeMap.has(key)) {
        p.anonymous_id = playerCodeMap.get(key);
        return p.anonymous_id;
      }

      const code = randomTwoLetterCode();
      if (key) playerCodeMap.set(key, code);
      p.anonymous_id = code;
      return code;
    }

    function getPlayerCode(p) {
      if (!p) return "??";
      const key = playerIdentityKey(p);
      if (key && playerCodeMap.has(key)) return playerCodeMap.get(key);
      return assignPlayerCode(p);
    }
    function getCurrentOvr(p, currentVersion) {
      const r = realPlayer(p);
      if (!r || !r.overall_history) return p.overall || 0;

      let ovr = getHistoryValue(r.overall_history, currentVersion);
      if (!ovr || ovr <= 1) {
        const versionList = seasons.map(s => s[2]);
        const currentIndex = versionList.indexOf(currentVersion);

        // Check backwards first
        for (let i = currentIndex - 1; i >= 0; i--) {
          let previousOvr = getHistoryValue(r.overall_history, versionList[i]);
          if (previousOvr && previousOvr > 1) {
            return previousOvr;
          }
        }
        // Check forwards if backwards didn't find anything
        for (let i = currentIndex + 1; i < versionList.length; i++) {
          let nextOvr = getHistoryValue(r.overall_history, versionList[i]);
          if (nextOvr && nextOvr > 1) {
            return nextOvr;
          }
        }
      }
      return ovr && ovr > 1 ? ovr : (p.overall || 0);
    }
    let formationMode = "down";

    function isToggleFormation() {
      const formation = document.getElementById("formation")?.value;
      return formation === "433" || formation === "532";
    }

    function getFormationSlots() {
      const formation = document.getElementById("formation")?.value;
      const slots = formations[formation].map(slot => [...slot]);
      if (isToggleFormation()) {
        const centralIndex = formation === "433" ? 6 : 7;
        slots[centralIndex][0] = formationMode === "up" ? "CAM" : "CDM";

        // Move the central midfielder with the mentality switch.
        // Attacking mode pushes the middle player higher into the CAM area;
        // defensive mode drops them back into the CDM area.
        slots[centralIndex][2] = formationMode === "up" ? 43 : (formation === "433" ? 59 : 57);
      }
      return slots;
    }

    function getFormationBoost(slotLabel) {
      if (!isToggleFormation()) return 0;
      if (formationMode === "up" && ["ST", "CF", "LW", "RW"].includes(slotLabel)) return 2;
      if (formationMode === "down" && ["GK", "LB", "CB", "RB", "LWB", "RWB"].includes(slotLabel)) return 1;
      return 0;
    }

    function setFormationMode(mode) {
      if (!isToggleFormation()) return;
      formationMode = mode;
      updateFormationControls();
      updateLiveStats();
      renderPitch();
      renderSquad();
    }

    function updateFormationControls() {
      const controls = document.getElementById("formationControls");
      if (!controls) return;
      const visible = isToggleFormation();
      controls.classList.toggle("visible", visible);
      document.getElementById("formationUp")?.classList.toggle("selected", visible && formationMode === "up");
      document.getElementById("formationDown")?.classList.toggle("selected", visible && formationMode === "down");
    }

    function getBoostedOvr(effectiveOvr, slotLabel) {
      if (!effectiveOvr) return effectiveOvr;
      return effectiveOvr + getFormationBoost(slotLabel);
    }

    function getLiveOvr() {
      let total = 0;
      const slots = getFormationSlots();
      const currentVersion = round < SEASON_COUNT ? seasons[Math.min(round, FINAL_SEASON_INDEX)][2] : seasons[FINAL_SEASON_INDEX][2];
      for (let i = 0; i < 11; i++) {
        let p = placements[i];
        if (p) {
          let actualOvr = getCurrentOvr(p, currentVersion);
          total += getBoostedOvr(getEffectiveOvr(actualOvr, p.position, slots[i][0]), slots[i][0]);
        }
      }
      // Squad OVR is always the average of an XI. A missing player therefore
      // counts as 0 rather than shrinking the denominator.
      return Math.floor(total / 11);
    }
    function updateLiveStats() {
      document.getElementById("budgetText").textContent = formatMoney(budget);
      document.getElementById("liveOvr").textContent = getLiveOvr();
    }


    async function getNextCareerNumber() {
      if (guestMode && !currentUser) {
        const next = Number(localStorage.getItem(GUEST_CAREER_COUNT_KEY) || 0) + 1;
        localStorage.setItem(GUEST_CAREER_COUNT_KEY, String(next));
        return next;
      }

      if (currentUser) {
        const { data, error } = await supabaseClient
          .from("career_history")
          .select("career_number")
          .eq("user_id", currentUser.id)
          .order("career_number", { ascending: false })
          .limit(1);

        if (!error && data && data.length) return Number(data[0].career_number) + 1;
        if (error) console.warn("Could not read career history:", error);
      }

      const fallbackKey = `the_vision_${currentUser?.id || "local"}_career_count_v1`;
      const next = Number(localStorage.getItem(fallbackKey) || 0) + 1;
      localStorage.setItem(fallbackKey, String(next));
      return next;
    }

    async function recordPlayerDiscovery(player, season, game, version) {
      if (!player || player.player_id == null) return;

      const playerId = Number(player.player_id);
      const age = getPlayerAge(player, round);
      const ovr = Number(player.overall);
      careerDiscoveryIds.add(String(playerId));
      careerDiscoveryCount++;

      const discovery = {
        player_id: playerId,
        career_number: careerNumber,
        season,
        game,
        ovr: Number.isFinite(ovr) ? ovr : null,
        age: Number.isFinite(Number(age)) ? Number(age) : null,
        position: player.position || null
      };

      if (!currentUser) {
        const existing = guestCollection[String(playerId)];
        guestCollection[String(playerId)] = existing
          ? {
              ...existing,
              times_discovered: Number(existing.times_discovered || 0) + 1,
              last_career: careerNumber,
              last_season: season
            }
          : {
              player_id: playerId,
              first_career: careerNumber,
              first_season: season,
              times_discovered: 1,
              last_career: careerNumber,
              last_season: season
            };

        guestDiscoveries.push(discovery);
        saveGuestStorage();
        return;
      }

      const { data: existing, error: fetchError } = await supabaseClient
        .from("player_collection")
        .select("*")
        .eq("user_id", currentUser.id)
        .eq("player_id", playerId)
        .maybeSingle();

      if (fetchError) {
        console.error("Collection lookup failed:", fetchError);
      } else if (existing) {
        const { error } = await supabaseClient
          .from("player_collection")
          .update({
            times_discovered: Number(existing.times_discovered || 0) + 1,
            last_career: careerNumber,
            last_season: season,
            updated_at: new Date().toISOString()
          })
          .eq("user_id", currentUser.id)
          .eq("player_id", playerId);
        if (error) console.error("Collection update failed:", error);
      } else {
        const { error } = await supabaseClient
          .from("player_collection")
          .insert({
            user_id: currentUser.id,
            player_id: playerId,
            first_career: careerNumber,
            first_season: season,
            times_discovered: 1,
            last_career: careerNumber,
            last_season: season
          });
        if (error) console.error("Collection insert failed:", error);
      }

      const { error: discoveryError } = await supabaseClient
        .from("player_discoveries")
        .insert({
          user_id: currentUser.id,
          ...discovery
        });

      if (discoveryError) console.error("Discovery log failed:", discoveryError);
    }

    async function recordPlayerSigning(player, season) {
      if (!player || player.player_id == null) return;

      const playerId = Number(player.player_id);
      if (!Number.isFinite(playerId)) return;

      if (!currentUser) {
        const existing = guestSignings[String(playerId)];
        guestSignings[String(playerId)] = existing
          ? {
              ...existing,
              times_signed: Number(existing.times_signed || 0) + 1,
              last_career: careerNumber,
              last_season: season
            }
          : {
              player_id: playerId,
              first_career: careerNumber,
              first_season: season,
              times_signed: 1,
              last_career: careerNumber,
              last_season: season
            };
        saveGuestStorage();
        return;
      }

      const { data: existing, error: fetchError } = await supabaseClient
        .from("player_signings")
        .select("*")
        .eq("user_id", currentUser.id)
        .eq("player_id", playerId)
        .maybeSingle();

      if (fetchError) {
        console.error("Signing lookup failed:", fetchError);
        return;
      }

      const payload = existing
        ? {
            times_signed: Number(existing.times_signed || 0) + 1,
            last_career: careerNumber,
            last_season: season,
            updated_at: new Date().toISOString()
          }
        : {
            user_id: currentUser.id,
            player_id: playerId,
            first_career: careerNumber,
            first_season: season,
            times_signed: 1,
            last_career: careerNumber,
            last_season: season
          };

      const query = existing
        ? supabaseClient.from("player_signings").update(payload).eq("user_id", currentUser.id).eq("player_id", playerId)
        : supabaseClient.from("player_signings").insert(payload);

      const { error } = await query;
      if (error) console.error("Signing record failed:", error);
    }

    // Supabase returns at most 1,000 rows by default. The scouting archive can
    // contain more than 1,000 unique players, so fetch these aggregate tables
    // in pages. We intentionally do NOT load player_discoveries here: that table
    // contains one row per encounter and can grow very large. The per-player
    // times_discovered value in player_collection is the source of truth for
    // the total encounter count.
    async function fetchAllRows(queryFactory, label) {
      const rows = [];
      const pageSize = 1000;
      let from = 0;

      while (true) {
        const { data, error } = await queryFactory(from, from + pageSize - 1);

        if (error) {
          console.error(`${label} load failed:`, error);
          break;
        }

        const page = data || [];
        rows.push(...page);

        if (page.length < pageSize) break;
        from += pageSize;
      }

      return rows;
    }

    async function loadScoutingRecordData() {
      let collectionRows = [];
      let signingRows = [];
      let discoveries = [];

      if (currentUser) {
        [collectionRows, signingRows] = await Promise.all([
          fetchAllRows(
            (from, to) => supabaseClient
              .from("player_collection")
              .select("*")
              .eq("user_id", currentUser.id)
              .range(from, to),
            "Collection"
          ),
          fetchAllRows(
            (from, to) => supabaseClient
              .from("player_signings")
              .select("*")
              .eq("user_id", currentUser.id)
              .range(from, to),
            "Signings"
          )
        ]);
      } else {
        loadGuestStorage();
        collectionRows = Object.values(guestCollection);
        signingRows = Object.values(guestSignings);
        discoveries = guestDiscoveries;
      }

      const discoveredIds = new Set(collectionRows.map(r => String(r.player_id)));
      const signedIds = new Set(signingRows.map(r => String(r.player_id)));

      const master = allPlayers
        ? (Array.isArray(allPlayers.players) ? allPlayers.players : Object.values(allPlayers.players || {}))
        : [];

      const players = master
        .map(p => realPlayer(p) || p)
        .filter(Boolean)
        .sort((a, b) => String(a.name || "").localeCompare(String(b.name || ""), undefined, { sensitivity: "base" }));

      return { players, discoveredIds, signedIds, discoveries, collectionRows, signingRows };
    }

    async function renderScoutingRecord() {
      const container = document.getElementById("scoutingRecord");
      if (!container) return;

      container.innerHTML = '<div class="panel"><div class="kicker">Loading</div><h3>Reading the scouting archive…</h3></div>';

      if (!allPlayers) {
        try {
          const response = await fetch("all_players_processed.json");
          if (response.ok) allPlayers = await response.json();
        } catch (e) {
          console.warn("Could not load player archive:", e);
        }
      }

      const { players, discoveredIds, signedIds, discoveries, collectionRows, signingRows } = await loadScoutingRecordData();
      const totalPlayers = players.length || 1603;
      const discoveredCount = discoveredIds.size;
      const signedCount = signedIds.size;
      const discoveredPct = totalPlayers ? ((discoveredCount / totalPlayers) * 100).toFixed(1) : "0.0";
      const signedPct = totalPlayers ? ((signedCount / totalPlayers) * 100).toFixed(1) : "0.0";

      // Do NOT use discoveries.length here. Supabase caps a normal select at
      // 1,000 rows, which made this value get stuck at exactly 1,000.
      // player_collection stores the cumulative encounter count per player.
      const totalEncounters = collectionRows.reduce(
        (n, r) => n + Math.max(0, Number(r.times_discovered || 0)),
        0
      );
      const totalSignings = signingRows.reduce((n, r) => n + Number(r.times_signed || 0), 0);

      const signedOrDiscovered = player => {
        const id = String(player.player_id);
        if (signedIds.has(id)) return "signed";
        if (discoveredIds.has(id)) return "discovered";
        return "undiscovered";
      };

      const filteredPlayers = players.filter(player => {
        const state = signedOrDiscovered(player);
        if (scoutingRecordFilter === "discovered") {
          return state === "discovered" || state === "signed";
        }
        if (scoutingRecordFilter === "signed") {
          return state === "signed";
        }
        if (scoutingRecordFilter === "undiscovered") {
          return state === "undiscovered";
        }
        return true;
      });

      const maxPage = Math.max(1, Math.ceil(filteredPlayers.length / SCOUTING_RECORD_PAGE_SIZE));
      scoutingRecordPage = Math.min(Math.max(1, scoutingRecordPage), maxPage);
      const start = (scoutingRecordPage - 1) * SCOUTING_RECORD_PAGE_SIZE;
      const pagePlayers = filteredPlayers.slice(start, start + SCOUTING_RECORD_PAGE_SIZE);

      container.innerHTML = `
        <div class="scoutingRecordHeader">
          <div>
            <div class="kicker">Manager's Player Archive</div>
            <div class="scoutingRecordTitle">Scouting Record</div>
            <div class="scoutingRecordIntro">Every player is listed alphabetically. Unknown players remain anonymous until you discover them; signed players are marked separately from players you have only scouted.</div>
          </div>
          <div class="badge">${filteredPlayers.length ? `${start + 1}–${Math.min(start + SCOUTING_RECORD_PAGE_SIZE, filteredPlayers.length)} / ${filteredPlayers.length}` : "0 / 0"}</div>
        </div>

        <div class="recordFilterBar">
          <div class="recordFilterLabel">Show</div>
          <select id="scoutingRecordFilter" onchange="setScoutingRecordFilter(this.value)">
            <option value="all" ${scoutingRecordFilter === "all" ? "selected" : ""}>Everyone</option>
            <option value="discovered" ${scoutingRecordFilter === "discovered" ? "selected" : ""}>Discovered</option>
            <option value="signed" ${scoutingRecordFilter === "signed" ? "selected" : ""}>Signed</option>
            <option value="undiscovered" ${scoutingRecordFilter === "undiscovered" ? "selected" : ""}>Not discovered</option>
          </select>
          <div class="recordFilterCount">${filteredPlayers.length} players shown</div>
        </div>

        <div class="recordProgress">
          <div class="recordProgressCard">
            <div class="recordProgressLabel"><span>Discovered</span><span>${discoveredCount} / ${totalPlayers} · ${discoveredPct}%</span></div>
            <div class="recordProgressTrack"><div class="recordProgressFill" style="width:${discoveredPct}%"></div></div>
            <div class="note">${totalEncounters} total scouting encounters</div>
          </div>
          <div class="recordProgressCard signed">
            <div class="recordProgressLabel"><span>Signed</span><span>${signedCount} / ${totalPlayers} · ${signedPct}%</span></div>
            <div class="recordProgressTrack"><div class="recordProgressFill" style="width:${signedPct}%"></div></div>
            <div class="note">${totalSignings} total signings</div>
          </div>
        </div>

        <div class="recordLegend">
          <span class="recordLegendItem"><i class="recordLegendSwatch unknown"></i> ??? Not discovered</span>
          <span class="recordLegendItem"><i class="recordLegendSwatch discovered"></i> Discovered · not signed</span>
          <span class="recordLegendItem"><i class="recordLegendSwatch signed"></i> Signed</span>
        </div>

        <div class="recordGrid">
          ${pagePlayers.map(player => {
            const state = signedOrDiscovered(player);
            const name = String(player.name || `Player ${player.player_id}`);
            const position = player.position || "—";
            const ovr = getCurrentOvr(player, seasons[FINAL_SEASON_INDEX][2]);
            const age = getPlayerAge(player, FINAL_SEASON_INDEX);
            const collection = collectionRows.find(r => String(r.player_id) === String(player.player_id));
            const signing = signingRows.find(r => String(r.player_id) === String(player.player_id));

            if (state === "undiscovered") {
              return `
                <div class="recordCard undiscovered">
                  <div class="recordCardStatus">Unknown</div>
                  <div class="recordCardCode">ARCHIVE ENTRY #${player.player_id}</div>
                  <div class="recordCardName">???</div>
                  <div class="recordCardMeta">This player has not entered your scouting book yet.</div>
                </div>`;
            }

            return `
              <div class="recordCard ${state}">
                <div class="recordCardStatus">${state === "signed" ? "Signed" : "Discovered"}</div>
                <div class="recordCardCode">${state === "signed" ? `SIGNED ${Number(signing?.times_signed || 1)}×` : `SEEN ${Number(collection?.times_discovered || 1)}×`}</div>
                <div class="recordCardName">${name}</div>
                <div class="recordCardMeta">${position} · OVR ${ovr || "—"}${age ? ` · AGE ${age}` : ""}</div>
              </div>`;
          }).join("")}
        </div>

        <div class="recordPagination">
          <button class="secondary" onclick="changeScoutingRecordPage(-1)" ${scoutingRecordPage <= 1 ? "disabled" : ""}>← Previous</button>
          <div class="recordPageLabel">Page ${scoutingRecordPage} / ${maxPage}</div>
          <button class="secondary" onclick="changeScoutingRecordPage(1)" ${scoutingRecordPage >= maxPage ? "disabled" : ""}>Next →</button>
        </div>
      `;
    }

    function setScoutingRecordFilter(filter) {
      const allowed = ["all", "discovered", "signed", "undiscovered"];
      scoutingRecordFilter = allowed.includes(filter) ? filter : "all";
      scoutingRecordPage = 1;
      renderScoutingRecord();
    }

    function changeScoutingRecordPage(delta) {
      scoutingRecordPage += delta;
      renderScoutingRecord();
    }

    async function showCollection() {
      // Backwards-compatible alias: Scouting Record now lives inside Achievements.
      await showAchievements();
    }

    async function showAchievements() {

      if (!currentUser && !guestMode) {
        show("auth");
        return;
      }

      await loadAchievements();
      if (currentUser) {
        await loadUserAchievements();
      } else {
        unlockedAchievements = new Set();
      }

      renderAchievements();
      document.getElementById("status").textContent = "Achievements";
      show("achievements");
      scoutingRecordPage = 1;
      await renderScoutingRecord();
    }


    function renderAchievements() {

      const container = document.getElementById("achievementList");

      const unlockedCount = achievementDefinitions.filter(a =>
        unlockedAchievements.has(a.id)
      ).length;

      document.getElementById("achievementCount").textContent =
        `${unlockedCount} / ${achievementDefinitions.length}`;

      container.innerHTML = `
        <div class="achievementGrid">

            ${achievementDefinitions.map(a => {

        const unlocked = unlockedAchievements.has(a.id);

        return `
                    <div class="achievement ${unlocked ? "" : "locked"}">

                        <div class="achievementIcon">
                            ${unlocked ? (a.icon || "🏆") : "🔒"}
                        </div>

                        <div class="achievementInfo">

                            <div class="achievementName">
                                ${a.name}
                            </div>

                            <div class="achievementDescription">
                                ${a.description}
                            </div>

                            <div class="achievementStatus ${unlocked
            ? "achievementUnlocked"
            : "achievementLocked"
          }">
                                ${unlocked ? "✓ Unlocked" : "🔒 Locked"}
                            </div>

                        </div>

                    </div>
                `;

      }).join("")}

        </div>
    `;
    }

    async function unlockAchievement(id) {

      if (!currentUser) return;

      // Already unlocked locally
      if (unlockedAchievements.has(id)) {
        return;
      }

      const { error } = await supabaseClient
        .from("user_achievements")
        .insert({
          user_id: currentUser.id,
          achievement_id: id
        });

      if (error) {

        // Ignore duplicate unlock attempts
        if (error.code === "23505") {
          unlockedAchievements.add(id);
          return;
        }

        console.error(
          `Failed to unlock achievement ${id}:`,
          error
        );

        return;
      }

      unlockedAchievements.add(id);

      console.log(`🏆 Achievement unlocked: ${id}`);

      showAchievementNotification(id);
    }


    function showAchievementNotification(id) {

      const achievement = achievementDefinitions.find(
        a => a.id === id
      );

      if (!achievement) return;

      const notification = document.createElement("div");

      notification.style.cssText = `
        position:fixed;
        right:20px;
        bottom:20px;
        z-index:9999;
        background:#fffdfa;
        color:#2c2c2c;
        border:2px solid #2c2c2c;
        border-radius:5px;
        padding:16px 20px;
        width:300px;
        box-shadow:5px 5px 0 rgba(0,0,0,0.15);
        font-family:monospace;
    `;

      notification.innerHTML = `
        <div style="
            font-size:10px;
            color:#666;
            text-transform:uppercase;
            letter-spacing:1px;
            margin-bottom:5px;
        ">
            Achievement Unlocked
        </div>

        <div style="
            font-family:Georgia,serif;
            font-size:20px;
            font-weight:900;
        ">
            ${achievement.icon || "🏆"} ${achievement.name}
        </div>

        <div style="
            font-size:11px;
            color:#555;
            margin-top:5px;
        ">
            ${achievement.description}
        </div>
    `;

      document.body.appendChild(notification);

      setTimeout(() => {
        notification.remove();
      }, 5000);
    }


    async function start() {
      try {
        const p = await fetch("season_pools.json"); if (!p.ok) throw Error();
        pools = await p.json();
        try { const a = await fetch("all_players_processed.json"); if (a.ok) { allPlayers = await a.json() } else { console.warn("all_players_processed.json not found") } } catch (e) { console.warn(e) }

        try {
          const plReq = await fetch("pl.csv");
          if (plReq.ok) {
            const text = await plReq.text();
            const cleanText = text.replace(/"([^"]*)"/g, (m, p1) => p1.replace(/[\r\n]+/g, '').trim());
            const lines = cleanText.split('\n');
            plData = {};
            for (let i = 1; i < lines.length; i++) {
              const parts = lines[i].split(',');
              if (parts.length >= 3) {
                let team = parts[0].trim();
                let ovr = parseInt(parts[1], 10);
                let version = parts[2].trim();
                if (!plData[version]) plData[version] = [];
                plData[version].push({ team, ovr });
              }
            }
            for (let v in plData) plData[v].sort((a, b) => b.ovr - a.ovr);
          }
        } catch (e) { console.warn(e) }

        // Load UEFA Champions League data.
        // In FC 26 the CSV uses "t" for the eight protected teams;
        // those are the direct-to-Round-of-16 "p" teams.
        try {
          const uclReq = await fetch("ucl.csv");
          if (uclReq.ok) {
            const text = await uclReq.text();
            const lines = text.replace(/^\uFEFF/, "").split(/\r?\n/);
            uclData = {};

            for (let i = 0; i < lines.length; i++) {
              const line = lines[i].trim();
              if (!line) continue;
              const parts = line.split(",");
              if (parts.length < 4) continue;

              const team = parts[0].trim();
              const game = parts[1].trim();
              const ovr = Number(parts[2].trim());
              const rawRole = parts[3].trim().toLowerCase();
              const role = rawRole === "t" ? "p" : rawRole;

              if (!team || !game || !Number.isFinite(ovr)) continue;
              if (!["r", "ir", "p"].includes(role)) continue;

              if (!uclData[game]) uclData[game] = [];
              uclData[game].push({ team, ovr, role });
            }
          } else {
            console.warn("ucl.csv not found");
          }
        } catch (e) { console.warn("Failed to load ucl.csv:", e) }
      } catch (e) { alert("season_pools.json must be in the same folder as index.html."); return }
      selections = []; used.clear(); placements = {}; round = 0; budget = 250000000; seasonResults = [];
      draftInProgress = false;
      swapSelection = null;
      chosen = null;
      options = [];
      careerDiscoveryIds = new Set();
      careerDiscoveryCount = 0;
      careerSaved = false;
      careerNumber = await getNextCareerNumber();

      // Random identity codes are regenerated for every new career.
      playerCodeMap = new Map();
      usedPlayerCodes = new Set();

      // Codes are assigned lazily when a player is actually shown/used.
      // This keeps the two-letter code space unique for players encountered
      // during a career instead of exhausting it across the whole database.

      // Generate default squad
      if (allPlayers) {
        const ps = Array.isArray(allPlayers.players) ? allPlayers.players : Object.values(allPlayers.players);
        // Build the default XI using the final season when available.
        // getCurrentOvr() deliberately falls back to the nearest available
        // historical rating, so adding FC 27 does not empty this pool when
        // some players do not have a 270xxx history entry yet.
        let pool = ps.filter(p => {
          const latestOvr = Number(getCurrentOvr(p, seasons[FINAL_SEASON_INDEX][2]) || 0);
          return latestOvr > 0 && latestOvr < 80;
        });
        pool = pool.sort(() => Math.random() - 0.5);

        const currentFormation = getFormationSlots();
        currentFormation.forEach((slot, i) => {
          if (!pool.length) return;
          const targetPos = slot[0];
          let pIndex = pool.findIndex(p => {
            if (p.position === targetPos) return true;
            for (let s of interchangeable) {
              if (s.has(p.position) && s.has(targetPos)) return true;
            }
            return false;
          });

          if (pIndex === -1) pIndex = 0;
          if (!pool[pIndex]) return;

          const p = pool[pIndex];
          pool.splice(pIndex, 1);

          const draftP = {
            player_id: p.player_id,
            anonymous_id: getPlayerCode(p),
            position: p.position,
            club: p.season_stats ? Object.values(p.season_stats)[0]?.club : "Unknown",
            overall: getHistoryValue(p.overall_history, seasons[FINAL_SEASON_INDEX][2]),
            potential: p.potential_history
              ? (getHistoryValue(p.potential_history, seasons[FINAL_SEASON_INDEX][2]) ?? getHistoryValue(p.overall_history, seasons[FINAL_SEASON_INDEX][2]))
              : getHistoryValue(p.overall_history, seasons[FINAL_SEASON_INDEX][2]),
            age: getPlayerAge(p, FINAL_SEASON_INDEX),
            season: seasons[FINAL_SEASON_INDEX][1],
            price: 0,
            is_default: true
          };
          selections.push(draftP);
          used.add(String(draftP.player_id));
          placements[i] = draftP;
        });
      }

      nextRound();
    }

    function show(id) { document.querySelectorAll(".screen").forEach(s => s.classList.remove("active")); document.getElementById(id).classList.add("active") }
    function club(c) { return Array.isArray(c) ? c.join(" / ") : (c || "Unknown") }
    function rating(x) { return x == null ? "N/A" : Number(x).toFixed(2) }
    function formationName() { return document.getElementById("formation").options[document.getElementById("formation").selectedIndex].text }

    function nextRound() {
      if (round >= SEASON_COUNT) { openFinal(); return }
      const [season, game, version] = seasons[round], d = pools[season];
      let available = (d.players || []).filter(p => {
        if (used.has(String(p.player_id))) return false;
        if (allPlayers) {
          const r = realPlayer(p);
          if (!r || !r.name) return false;
        }
        return true;
      }).sort(() => Math.random() - .5);

      let chosenOpts = [];
      let gkCount = 0;
      for (let p of available) {
        if (chosenOpts.length === 3) break;
        if (p.position === 'GK') {
          if (gkCount < 1) { gkCount++; chosenOpts.push(p); }
        } else { chosenOpts.push(p); }
      }
      options = chosenOpts.map(o => normalizePlayerAge(o, round));
      chosen = null;

      // Every card presented to the manager counts as a discovery.
      for (const discovered of options) {
        recordPlayerDiscovery(discovered, season, game, version);
      }

      // Calculate prices
      options.forEach(o => {
        const r = realPlayer(o);
        if (!r) { o.price = 0; return; }
        const val = parseValue(r.value);
        const ovrCurrent = Number(o.overall || 0);
        const currentVersion = seasons[round][2];
        const seasonBaseOvr = Number(getHistoryValue(r.overall_history, currentVersion) || ovrCurrent || 1);
        o.price = Math.floor((val * ovrCurrent) / (seasonBaseOvr || 1));
      });

      document.getElementById("status").textContent = `Round ${round + 1} / ${SEASON_COUNT}`;
      document.getElementById("round").textContent = `Round ${round + 1} of ${SEASON_COUNT}`;
      document.getElementById("season").textContent = season;
      document.getElementById("options").innerHTML = options.map((p, i) => {
        const canAfford = budget >= p.price;
        return `
  <div class="card ${canAfford ? '' : 'disabled'}" onclick="${canAfford ? `choose(${i})` : ''}" style="${canAfford ? '' : 'opacity:0.5;cursor:not-allowed'}">
   <div class="anon">ID · ${getPlayerCode(p)}</div><div class="pos">${p.position || "N/A"}</div><div class="club">${club(p.club)}</div>
   <div class="stats">
    <div class="stat"><small>PRICE</small><b style="color:${canAfford ? '#2c7a2c' : '#a00'}">${formatMoney(p.price)}</b></div>
    <div class="stat"><small>OVERALL</small><b>${p.overall ?? "N/A"}</b></div>
    <div class="stat"><small>POTENTIAL</small><b>${p.potential ?? "N/A"}</b></div>
    <div class="stat"><small>AGE</small><b>${p.age ?? "N/A"}</b></div>
   </div>
  </div>`
      }).join("");
      document.getElementById("options").style.display = "grid";
      document.querySelector("#draft .actions").innerHTML = `
    <span class="note">Pick a player to add them to your XI.</span>
    <div>
        <button class="secondary" onclick="skipDraft()" style="margin-right:8px;">Skip</button>
        <button id="draftBtn" class="primary" disabled onclick="draft()">Draft</button>
    </div>
 `;
      updateLiveStats();
      renderPitch(); renderSquad(); show("draft");
    }

    function choose(i) { chosen = i; document.querySelectorAll(".card").forEach((x, n) => x.classList.toggle("selected", n === i)); document.getElementById("draftBtn").disabled = false }



    function skipDraft() {
      // Skipping does not change the squad OVR, so there is no meaningful
      // OVR delta to calculate here.
      const ovrChangeEl = document.getElementById("ovrChange");
      if (ovrChangeEl) ovrChangeEl.innerHTML = `<span style="color:#555;">(0)</span>`;

      document.getElementById("options").style.display = "none";
      document.querySelector("#draft .actions").innerHTML = `<button class="primary" onclick="simulateCurrentSeason()" style="width:100%">Simulate Season</button>`;
    }

    // Resolve a player's age for a specific season.
    // The season pool is preferred, then the master database, and finally
    // the FC27 age is moved backwards one year per season. This is kept in
    // one function so scouting cards, squad cards, and drafted players all
    // use exactly the same age logic.
    function getPlayerAge(p, roundIndex = FINAL_SEASON_INDEX) {
      if (!p) return null;

      // 1. Age from the master player record (this is the FC27/current age).
      const real = realPlayer(p);
      const masterAge = Number(real?.age);
      if (Number.isFinite(masterAge) && masterAge > 0) {
        const seasonsBack = Math.max(0, FINAL_SEASON_INDEX - roundIndex);
        return Math.round(masterAge - seasonsBack);
      }

      // 2. Age explicitly stored on the season-pool player.
      const poolAge = Number(p.age);
      if (Number.isFinite(poolAge) && poolAge > 0) return Math.round(poolAge);

      return null;
    }

    function normalizePlayerAge(p, roundIndex = FINAL_SEASON_INDEX) {
      if (!p) return p;
      const age = getPlayerAge(p, roundIndex);
      p.age = age;
      return p;
    }

    let draftInProgress = false;

    async function draft() {
      // Prevent double-clicks / rapid repeated taps from drafting the same
      // player more than once while the async signing request is processing.
      if (draftInProgress) return;
      if (chosen == null || !options[chosen]) return;

      draftInProgress = true;
      const draftBtn = document.getElementById("draftBtn");
      if (draftBtn) {
        draftBtn.disabled = true;
        draftBtn.textContent = "Drafting…";
      }

      const prevOvr = getLiveOvr();
      const [season, game, version] = seasons[round];
      const source = options[chosen];

      // A second protection layer in case this function is triggered by
      // something other than the button while the player is already used.
      if (used.has(String(source.player_id))) {
        draftInProgress = false;
        if (draftBtn) {
          draftBtn.disabled = false;
          draftBtn.textContent = "Draft";
        }
        return;
      }
      const p = {
        ...source,
        season,
        game,
        version,
        age: getPlayerAge(source, round)
      };

      // Commit the local draft state before the async persistence call so a
      // second click cannot draft the same player. If persistence fails,
      // roll the local state back so the player can be drafted again.
      selections.push(p);
      used.add(String(p.player_id));
      budget -= p.price;

      try {
        await recordPlayerSigning(p, season);
      } catch (e) {
        console.error("Player signing save failed:", e);
        selections.pop();
        used.delete(String(p.player_id));
        budget += p.price;
        draftInProgress = false;
        if (draftBtn) {
          draftBtn.disabled = false;
          draftBtn.textContent = "Draft";
        }
        alert("The signing could not be saved. Please try drafting the player again.");
        return;
      }

      const firstEmpty = formations[document.getElementById("formation").value].findIndex((_, i) => !placements[i]);
      if (firstEmpty >= 0) placements[firstEmpty] = p;
      const newOvr = getLiveOvr();

      const diff = newOvr - prevOvr;
      const ovrChangeEl = document.getElementById("ovrChange");
      if (diff > 0) { ovrChangeEl.innerHTML = `<span style="color:#2c7a2c;">(+${diff})</span>`; }
      else if (diff < 0) { ovrChangeEl.innerHTML = `<span style="color:#a00;">(${diff})</span>`; }
      else { ovrChangeEl.innerHTML = `<span style="color:#555;">(0)</span>`; }

      updateLiveStats(); renderPitch(); renderSquad();
      document.getElementById("options").style.display = "none";
      document.querySelector("#draft .actions").innerHTML = `<button class="primary" onclick="simulateCurrentSeason()" style="width:100%">Simulate Season</button>`;

      // The async lock is only for the duration of this draft operation.
      // Release it now so the next season can draft normally.
      draftInProgress = false;
    }

    function formationChanged() {
      updateFormationControls();
      renderPitch();
      renderSquad();
      updateLiveStats();
    }

    let swapSelection = null;

    function renderPitch(target = "pitch") {
      updateFormationControls();
      const pitch = document.getElementById(target); if (!pitch) return;
      pitch.innerHTML = `
        <div class="pitchMark pitchHalfwayLine"></div>
        <div class="pitchMark pitchCenterArc"></div>
        <div class="pitchMark pitchCenterSpot"></div>
        <div class="pitchMark penaltyArea bottom"></div>
        <div class="pitchMark goalArea bottom"></div>
        <div class="pitchMark penaltySpot"></div>
        <div class="pitchMark penaltyArc"></div>
        <div class="goal bottom"></div>
        <div class="cornerArc left"></div>
        <div class="cornerArc right"></div>`;
      const slots = getFormationSlots();
      const currentVersion = round < SEASON_COUNT ? seasons[Math.min(round, FINAL_SEASON_INDEX)][2] : seasons[FINAL_SEASON_INDEX][2];
      slots.forEach((slot, i) => {
        const [label, x, y] = slot, p = placements[i];
        const w = document.createElement("div"); w.className = "slotWrap"; w.style.left = x + "%"; w.style.top = y + "%";

        let displayName = "+";
        let displayOvr = "";
        let isOutOfPos = false;
        if (p) {
          displayName = getPlayerCode(p);
          displayOvr = getCurrentOvr(p, currentVersion);
          const eff = getEffectiveOvr(displayOvr, p.position, label);
          if (eff < displayOvr || eff === 0) isOutOfPos = true;
          displayOvr = getBoostedOvr(eff, label);
        }

        const isSelected = swapSelection && swapSelection.type === 'pitch' && swapSelection.index === i;
        let slotStyle = isSelected ? 'border-color:#2c7a2c; background:#e8f4e8;' : '';
        if (!isSelected && isOutOfPos) slotStyle = 'border-color:#cc4444; background:#ffe6e6;';

        w.innerHTML = `<div class="slot ${p ? "" : "empty"}" style="${slotStyle}">${displayName}</div><div class="label" style="${isOutOfPos ? 'color:#cc4444' : ''}">${p ? p.position : label} ${p ? displayOvr : ''}</div>`;
        const s = w.querySelector(".slot");

        s.onclick = () => handleSwapClick('pitch', i);
        pitch.appendChild(w);
      });
    }

    function handleSwapClick(type, index) {
      let clickedPlayer = type === 'pitch' ? placements[index] : selections[index];
      if (clickedPlayer && clickedPlayer.injured_until === round) {
        alert("This player is injured and cannot be selected until next season.");
        return;
      }

      if (!swapSelection) {
        swapSelection = { type, index };
        renderPitch(); renderSquad();
        return;
      }

      if (swapSelection.type === type && swapSelection.index === index) {
        swapSelection = null;
        renderPitch(); renderSquad();
        return;
      }

      // Do swap
      let p1 = swapSelection.type === 'pitch' ? placements[swapSelection.index] : selections[swapSelection.index];
      let p2 = type === 'pitch' ? placements[index] : selections[index];

      // Find their real indices in placements if any
      let old1 = -1, old2 = -1;
      for (const k of Object.keys(placements)) {
        if (placements[k] && p1 && String(placements[k].player_id) === String(p1.player_id)) old1 = Number(k);
        if (placements[k] && p2 && String(placements[k].player_id) === String(p2.player_id)) old2 = Number(k);
      }

      if (type === 'pitch' && swapSelection.type === 'pitch') {
        // Swap pitch to pitch
        placements[index] = p1;
        placements[swapSelection.index] = p2;
      } else if (type === 'pitch' && swapSelection.type === 'squad') {
        // Move/swap a squad player onto the pitch.
        // If that player is already on the pitch, swap the two pitch positions.
        if (old1 >= 0) {
          placements[index] = p1;
          placements[old1] = p2;
        } else {
          // p1 was an unplaced squad player. Remove the player currently in the target
          // slot, then put p1 there. This keeps every player unique in the XI.
          placements[index] = p1;
          if (old2 >= 0 && old2 !== index) delete placements[old2];
        }
      } else if (type === 'squad' && swapSelection.type === 'pitch') {
        // Pitch slot was selected first. Put the clicked squad player into
        // that slot. If the squad player was already on the pitch, move the
        // player from the selected pitch slot into the squad player's old slot.
        const pitchIndex = swapSelection.index;

        if (old2 >= 0) {
          // Both players are already on the pitch: exchange their positions.
          placements[pitchIndex] = p2;
          placements[old2] = p1;
        } else {
          // Squad player was not on the pitch: remove the old pitch player
          // from the XI and put the squad player into the selected slot.
          placements[pitchIndex] = p2;
        }
      }

      swapSelection = null;
      updateLiveStats(); renderPitch(); renderSquad();
    }

    function renderSquad() {
      const box = document.getElementById("squad");
      const currentVersion = round < SEASON_COUNT ? seasons[Math.min(round, FINAL_SEASON_INDEX)][2] : seasons[FINAL_SEASON_INDEX][2];

      const groups = {
        goalkeepers: [],
        defenders: [],
        midfielders: [],
        forwards: []
      };

      function positionGroup(position) {
        const pos = String(position || "").toUpperCase();

        if (pos === "GK") return "goalkeepers";

        if (["LB", "LWB", "CB", "RB", "RWB", "SW"].includes(pos)) {
          return "defenders";
        }

        if (["CDM", "CM", "CAM", "LM", "RM", "DM", "AM"].includes(pos)) {
          return "midfielders";
        }

        if (["LW", "RW", "ST", "CF", "LF", "RF"].includes(pos)) {
          return "forwards";
        }

        // Unknown positions are grouped with midfielders rather than hidden.
        return "midfielders";
      }

      selections.forEach((p, i) => {
        const group = positionGroup(p.position);
        groups[group].push({ p, i });
      });

      function playerCard(p, i) {
        const placed = Object.values(placements).some(
          x => x && String(x.player_id) === String(p.player_id)
        );
        const isSelected =
          swapSelection &&
          swapSelection.type === "squad" &&
          swapSelection.index === i;

        const actualOvr = getCurrentOvr(p, currentVersion);
        const nameDisp = getPlayerCode(p);
        const isInjured = p.injured_until === round;

        return `<div class="squadPlayer"
          onclick="handleSwapClick('squad', ${i})"
          style="opacity:${placed ? 0.4 : (isInjured ? 0.5 : 1)};
                 ${isSelected ? 'border-color:#2c7a2c; background:#e8f4e8;' : ''}
                 ${isInjured ? 'background:#fcc;' : ''}">
          <strong>${nameDisp} · ${p.position || "N/A"} · OVR ${actualOvr}</strong>
          ${isInjured
            ? '<span style="color:#a00;font-weight:bold;margin-left:5px;font-size:10px;">(INJURED)</span>'
            : ''}
        </div>`;
      }

      const groupInfo = [
        ["goalkeepers", "Goalkeepers"],
        ["defenders", "Defenders"],
        ["midfielders", "Midfielders"],
        ["forwards", "Forwards"]
      ];

      box.innerHTML = groupInfo.map(([key, title]) => {
        const players = groups[key];

        return `
          <div class="positionGroup">
            <div class="positionGroupTitle">
              <span>${title}</span>
              <span class="positionGroupCount">${players.length} PLAYER${players.length === 1 ? "" : "S"}</span>
            </div>
            ${players.length
              ? players.map(({ p, i }) => playerCard(p, i)).join("")
              : `<div class="note" style="padding:6px 2px;">No players</div>`}
          </div>
        `;
      }).join("");
    }

    function openFinal() {
      document.getElementById("status").textContent = "Draft Complete";
      document.getElementById("finalFormation").textContent = formationName();
      renderPitch("finalPitch"); show("final");
    }
    function backToDraft() { show("draft"); renderPitch(); renderSquad() }

    function realPlayer(p) {
      if (!allPlayers) return null;
      const ps = allPlayers.players || allPlayers;
      const id = String(p.player_id);
      if (Array.isArray(ps)) {
        return ps.find(x => String(x.player_id ?? x.id) === id) || null;
      }
      return ps[id] || ps[p.player_id] || null;
    }
    function peak(real, p) {
      if (!real) return Math.max(Number(p.overall || 0), Number(p.potential || 0));
      const vals = Object.values(real.overall_history || {}).filter(v => typeof v === "number");
      return vals.length ? Math.max(...vals) : Number(p.overall || 0);
    }
    function career(real) {
      if (!real || !real.overall_history) return "Career history unavailable.";
      return Object.entries(real.overall_history).filter(([s, v]) => typeof v === "number").sort((a, b) => a[0].localeCompare(b[0])).map(([s, v]) => `${s}: ${v}`).join(" · ");
    }
    async function reveal() {
      let squadTotal = 0;
      const currentFormation = getFormationSlots();
      const currentVersion = seasons[FINAL_SEASON_INDEX][2]; // Final season
      const revealPitch = document.getElementById("revealPitch");
      const revealSquadGrid = document.getElementById("revealSquadGrid");
      revealPitch.innerHTML = `
        <div class="pitchMark pitchHalfwayLine"></div>
        <div class="pitchMark pitchCenterArc"></div>
        <div class="pitchMark pitchCenterSpot"></div>
        <div class="pitchMark penaltyArea bottom"></div>
        <div class="pitchMark goalArea bottom"></div>
        <div class="pitchMark penaltySpot"></div>
        <div class="pitchMark penaltyArc"></div>
        <div class="goal bottom"></div>
        <div class="cornerArc left"></div>
        <div class="cornerArc right"></div>`;
      revealSquadGrid.innerHTML = "";

      let historyHtml = '<div style="margin-top:24px;"><h3 style="font-family:Georgia,serif;font-size:20px;border-bottom:1px solid #ddd;padding-bottom:8px;margin-bottom:12px;">Season Results</h3><div style="display:grid;grid-template-columns:repeat(auto-fill, minmax(180px, 1fr));gap:12px;">';
      seasonResults.forEach(r => {
        let suffix = 'th';
        if (r.pos === 1) suffix = 'st'; else if (r.pos === 2) suffix = 'nd'; else if (r.pos === 3) suffix = 'rd';
        historyHtml += `<div style="background:#f4f1ea;padding:10px;border:1px solid #d0c8b6;border-radius:4px;"><small style="color:#666;font-family:monospace;display:block;">${r.season}</small><strong style="font-size:18px;">${r.pos}${suffix}</strong><span style="float:right;color:#666;font-size:12px;margin-top:4px;">OVR ${r.ovr}</span>${r.ucl ? `<div style="margin-top:6px;font-size:10px;font-family:monospace;color:${r.ucl.playerChampion ? '#2c7a2c' : '#666'};">UCL: ${r.ucl.playerChampion ? 'CHAMPIONS' : (r.ucl.eliminatedRound ? 'Elim. ' + r.ucl.eliminatedRound : 'N/A')}</div>` : ''}</div>`;
      });
      historyHtml += '</div></div>';
      document.getElementById("score").insertAdjacentHTML("afterend", historyHtml);

      currentFormation.forEach((slot, i) => {
        const [label, x, y] = slot, p = placements[i];
        if (!p) return;
        const r = realPlayer(p), name = r?.name || null;
        if (!name) return; // Hide player entirely if no name found
        const actualOvr = getCurrentOvr(p, currentVersion);
        const positionOvr = getEffectiveOvr(actualOvr, p.position, label);
        const effectiveOvr = getBoostedOvr(positionOvr, label);
        squadTotal += effectiveOvr;

        let penaltyText = "";
        if (effectiveOvr === 0 && actualOvr > 0) penaltyText = "<br><span style='color:#ff6b6b;'>Out of Pos</span>";
        else if (effectiveOvr < actualOvr) penaltyText = `<br><span style='color:#ffb8b8;'>- ${actualOvr - effectiveOvr} Penalty</span>`;

        const w = document.createElement("div");
        w.className = "revealPitchCard";
        w.style.position = "absolute";
        w.style.transform = "translate(-50%,-50%)";
        w.style.left = x + "%";
        w.style.top = y + "%";
        w.style.textAlign = "center";
        w.style.zIndex = "3";

        const shortName = name.length > 8 ? name.split(/\s+/).map(part => part[0]).join("").slice(0, 3) : name;
        w.innerHTML = `
          <div class="revealPitchDetails">
            <strong>${name}</strong>
            <div class="revealPitchOvr" style="color:#666; margin-top:2px;">OVR ${effectiveOvr}</div>
            <div class="revealPitchPosition" style="background:#2c2c2c; color:#fff; display:inline-block; padding:2px 4px; border-radius:2px; font-size:9px; margin-top:4px;">${label}</div>
          </div>
        `;
        const pitchName = w.querySelector("strong");
        pitchName.dataset.fullName = name;
        pitchName.textContent = name;
        if (window.matchMedia("(max-width: 700px)").matches) {
          pitchName.textContent = shortName;
        }
        revealPitch.appendChild(w);

        const card = document.createElement("div");
        card.className = "revealSquadCard";
        card.innerHTML = `
          <div class="revealSquadPosition">${label} · ${p.position || "—"}</div>
          <div class="revealSquadName">${name}</div>
          <div class="revealSquadMeta">OVR ${effectiveOvr}</div>
        `;
        document.getElementById("revealSquadGrid").appendChild(card);
      });

      const finalSquadOvr = Math.floor(squadTotal / 11);

      document.getElementById("score").innerHTML = `<strong>${finalSquadOvr}</strong>`;
      checkScoutingAchievements();
      checkMoneyballAchievement();
      checkOracleAchievement();
      if (budget >= 100000000) {
        unlockAchievement("billionaire");
      }
      document.getElementById("status").textContent = "Revealed";
      unlockAchievement("first_career");
      renderCareerSummary();
      await saveCareerHistory();
      show("reveal");
    }

    function getCareerStats() {
      const positions = seasonResults.map(r => Number(r.pos)).filter(Number.isFinite);
      const leagueTitles = seasonResults.filter(r => Number(r.pos) === 1).length;
      const uclTitles = seasonResults.filter(r => r.ucl?.playerChampion).length;
      return {
        leagueTitles,
        uclTitles,
        bestPosition: positions.length ? Math.min(...positions) : null,
        worstPosition: positions.length ? Math.max(...positions) : null,
        finalOvr: Number(document.getElementById("score")?.textContent || 0) || getLiveOvr(),
        playersScouted: careerDiscoveryCount,
        uniquePlayers: careerDiscoveryIds.size
      };
    }

    function buildFinalXIShareLines() {
      const currentFormation = getFormationSlots();
      const currentVersion = seasons[FINAL_SEASON_INDEX][2];
      const lines = ["FINAL XI:"];

      currentFormation.forEach(([label], i) => {
        const p = placements[i];
        if (!p) {
          lines.push(`${label}: —`);
          return;
        }

        const r = realPlayer(p);
        const name = r?.name || "Unknown Player";
        const actualOvr = getCurrentOvr(p, currentVersion);
        const positionOvr = getEffectiveOvr(actualOvr, p.position, label);
        const effectiveOvr = getBoostedOvr(positionOvr, label);
        lines.push(`${label}: ${name} (${effectiveOvr} OVR)`);
      });

      return lines;
    }

    function buildCareerSummaryText() {
      const stats = getCareerStats();
      const team = getCurrentPlayerTeamName();
      const best = stats.bestPosition ? `${stats.bestPosition}${stats.bestPosition === 1 ? "st" : stats.bestPosition === 2 ? "nd" : stats.bestPosition === 3 ? "rd" : "th"}` : "—";
      const worst = stats.worstPosition ? `${stats.worstPosition}${stats.worstPosition === 1 ? "st" : stats.worstPosition === 2 ? "nd" : stats.worstPosition === 3 ? "rd" : "th"}` : "—";
      return [
        `THE VISION — CAREER #${careerNumber}`,
        team,
        `Formation: ${formationName()}`,
        `Final XI OVR: ${stats.finalOvr}`,
        `League titles: ${stats.leagueTitles}`,
        `UCL titles: ${stats.uclTitles}`,
        `Best finish: ${best}`,
        `Worst finish: ${worst}`,
        `Players scouted: ${stats.playersScouted}`,
        `Unique players discovered: ${stats.uniquePlayers}`,
        "",
        ...buildFinalXIShareLines(),
        "",
        "Can you build the perfect team without knowing who you're signing?",
        "Play The Vision at https://the-vision-scouting.vercel.app/"
      ].join("\n");
    }

    async function shareCareerSummary() {
      const summary = buildCareerSummaryText();
      try {
        if (navigator.share) {
          await navigator.share({
            title: `The Vision — Career #${careerNumber}`,
            text: summary
          });
          return;
        }
      } catch (e) {
        if (e?.name === "AbortError") return;
      }

      await copyCareerSummary();
      alert("Career summary copied to your clipboard.");
    }

    async function copyCareerSummary() {
      const summary = buildCareerSummaryText();
      try {
        await navigator.clipboard.writeText(summary);
      } catch (e) {
        const area = document.createElement("textarea");
        area.value = summary;
        area.style.position = "fixed";
        area.style.opacity = "0";
        document.body.appendChild(area);
        area.select();
        document.execCommand("copy");
        area.remove();
      }
    }

    async function saveCareerHistory() {
      if (careerSaved) return;

      const stats = getCareerStats();
      const row = {
        career_number: careerNumber,
        team_name: getCurrentPlayerTeamName(),
        formation: formationName(),
        final_ovr: stats.finalOvr,
        league_titles: stats.leagueTitles,
        ucl_titles: stats.uclTitles,
        best_position: stats.bestPosition,
        worst_position: stats.worstPosition,
        players_scouted: stats.playersScouted,
        unique_players_discovered: stats.uniquePlayers
      };

      if (!currentUser) {
        guestCareers.push(row);
        saveGuestStorage();
        // Keep the completed run available on the reveal screen for optional
        // account migration. The next guest session will start fresh.
        localStorage.setItem(GUEST_RUN_COMPLETED_KEY, "1");
        careerSaved = true;
        return;
      }

      const { error } = await supabaseClient
        .from("career_history")
        .upsert({
          user_id: currentUser.id,
          ...row
        }, { onConflict: "user_id,career_number" });

      if (error) {
        console.error("Career history save failed:", error);
        return;
      }

      careerSaved = true;
    }

    function renderCareerSummary() {
      const stats = getCareerStats();
      const team = getCurrentPlayerTeamName();
      const best = stats.bestPosition ? `${stats.bestPosition}${stats.bestPosition === 1 ? "st" : stats.bestPosition === 2 ? "nd" : stats.bestPosition === 3 ? "rd" : "th"}` : "—";
      const worst = stats.worstPosition ? `${stats.worstPosition}${stats.worstPosition === 1 ? "st" : stats.worstPosition === 2 ? "nd" : stats.worstPosition === 3 ? "rd" : "th"}` : "—";

      document.getElementById("careerSummaryPanel").innerHTML = `
        <div class="kicker">Career Archive · #${careerNumber}</div>
        <h2 style="font-family:Georgia,serif;font-size:30px;margin:5px 0 16px;">${team}</h2>
        <div class="stats">
          <div class="stat"><small>FINAL OVR</small><b>${stats.finalOvr}</b></div>
          <div class="stat"><small>LEAGUE TITLES</small><b>${stats.leagueTitles}</b></div>
          <div class="stat"><small>UCL TITLES</small><b>${stats.uclTitles}</b></div>
          <div class="stat"><small>BEST FINISH</small><b>${best}</b></div>
          <div class="stat"><small>WORST FINISH</small><b>${worst}</b></div>
          <div class="stat"><small>UNIQUE DISCOVERIES</small><b>${stats.uniquePlayers}</b></div>
        </div>
      `;
      document.getElementById("saveGuestButton").style.display =
        (!currentUser && guestMode) ? "inline-block" : "none";
    }

    function checkOracleAchievement() {

      for (const p of selections) {

        if (p.is_default) continue;

        const real = realPlayer(p);

        if (!real) continue;

        const startingOvr = Number(p.overall || 0);
        const peakOvr = peak(real, p);

        if (
          startingOvr > 0 &&
          peakOvr - startingOvr >= 20
        ) {
          unlockAchievement("perfect_scout");
          return;
        }
      }
    }



    function checkMoneyballAchievement() {

      for (const p of selections) {

        if (p.is_default) continue;

        const real = realPlayer(p);

        if (!real) continue;

        const peakOvr = peak(real, p);

        if (
          Number(p.price) < 5000000 &&
          peakOvr >= 85
        ) {
          unlockAchievement("moneyball");
          return;
        }
      }
    }

    function checkScoutingAchievements() {

      for (const p of selections) {

        if (p.is_default) continue;

        const real = realPlayer(p);

        if (!real) continue;

        const peakOvr = peak(real, p);

        if (peakOvr >= 90) {
          unlockAchievement("wonderkid");
        }
      }
    }

    let currentSeasonStandings = null;

    function simulateCurrentSeason() {
      const xiCount = Array.from({ length: 11 }, (_, i) => placements[i]).filter(Boolean).length;
      if (xiCount !== 11) {
        alert('You must have 11 players in your XI before simulating the season.');
        return;
      }

      for (let i = 0; i < 11; i++) {
        if (placements[i]) placements[i].seasonGoals = 0;
      }

      const [season, game, version] = seasons[round];

      let teams = [];
      if (plData[game]) {
        teams = JSON.parse(JSON.stringify(plData[game]));
      } else {
        teams = Array(20).fill(0).map((_, i) => ({ team: "Generic Team " + i, ovr: 75 }));
      }

      teams.sort((a, b) => b.ovr - a.ovr);
      teams.pop();

      const myOvr = getLiveOvr();

      // Hidden player-team simulation boost: the displayed OVR remains unchanged.
      const effectivePlayerOvr = myOvr + 2;

      const teamNameInput = document.getElementById("teamName");
      const tName = teamNameInput ? (teamNameInput.value || "The Vision FC") : "The Vision FC";
      teams.push({
        team: tName,
        ovr: myOvr,
        effectiveOvr: effectivePlayerOvr,
        isPlayer: true
      });

      const standings = teams.map(t => ({ ...t, p: 0, w: 0, d: 0, l: 0, gf: 0, ga: 0, pts: 0 }));

      for (let i = 0; i < standings.length; i++) {
        for (let j = i + 1; j < standings.length; j++) {
          simulateMatch(standings[i], standings[j]);
        }
      }

      currentSeasonStandings = standings;
      renderStandings("Mid-Season Results", "Finish Season", "finishSeason()");
    }

    // League simulation tuning.
    const LEAGUE_OVR_SCALE = 30;
    const HOME_ADVANTAGE_OVR = 3;

    function simulateMatch(t1, t2) {
      const t1EffectiveOvr = Number.isFinite(t1.effectiveOvr) ? t1.effectiveOvr : t1.ovr;
      const t2EffectiveOvr = Number.isFinite(t2.effectiveOvr) ? t2.effectiveOvr : t2.ovr;

      // Home advantage is applied only to the simulation, never displayed.
      const D = (t1EffectiveOvr + HOME_ADVANTAGE_OVR) - t2EffectiveOvr;

      // Keep the overall scoring environment stable; OVR determines the split.
      const totalExpectedGoals = 2.7;
      const strength = Math.exp(D / LEAGUE_OVR_SCALE);
      const reverseStrength = Math.exp(-D / LEAGUE_OVR_SCALE);
      const homeShare = strength / (strength + reverseStrength);
      const awayShare = 1 - homeShare;

      const lambda1 = totalExpectedGoals * homeShare;
      const lambda2 = totalExpectedGoals * awayShare;

      let g1 = samplePoisson(lambda1);
      let g2 = samplePoisson(lambda2);

      t1.p++; t2.p++;
      t1.gf += g1; t1.ga += g2;
      t2.gf += g2; t2.ga += g1;

      if (g1 > g2) { t1.pts += 3; t1.w++; t2.l++; }
      else if (g2 > g1) { t2.pts += 3; t2.w++; t1.l++; }
      else { t1.pts += 1; t2.pts += 1; t1.d++; t2.d++; }

      if (t1.isPlayer || t2.isPlayer) {
         const playerTeamGoals = t1.isPlayer ? g1 : g2;
         distributeGoals(playerTeamGoals);
      }
    }

    async function collectPlayer(player) {
      if (!player) return;
      const [season, game, version] = seasons[Math.min(round, FINAL_SEASON_INDEX)];
      await recordPlayerDiscovery(player, season, game, version);
    }

    function distributeGoals(goals) {
      if (goals <= 0) return;
      const fwds = [], mids = [], defs = [];
      const slots = formations[document.getElementById("formation").value];
      
      for (let i = 0; i < 11; i++) {
        let p = placements[i];
        if (p) {
          let label = slots[i][0];
          if (['ST', 'CF', 'LW', 'RW'].includes(label)) fwds.push(p);
          else if (['CM', 'CDM', 'CAM', 'LM', 'RM'].includes(label)) mids.push(p);
          else defs.push(p);
        }
      }

      for (let i = 0; i < goals; i++) {
        let r = Math.random();
        let group = null;
        if (r < 0.60) group = fwds.length > 0 ? fwds : (mids.length > 0 ? mids : defs);
        else if (r < 0.90) group = mids.length > 0 ? mids : (fwds.length > 0 ? fwds : defs);
        else group = defs.length > 0 ? defs : (mids.length > 0 ? mids : fwds);
        
        if (group && group.length > 0) {
          let scorer = group[Math.floor(Math.random() * group.length)];
          scorer.goals = (scorer.goals || 0) + 1;
          scorer.seasonGoals = (scorer.seasonGoals || 0) + 1;
        }
      }
    }

    function finishSeason() {
      const xiCount = Array.from({ length: 11 }, (_, i) => placements[i]).filter(Boolean).length;
      if (xiCount !== 11) {
        alert('You must have 11 players in your XI before finishing the season.');
        return;
      }

      const standings = currentSeasonStandings;
      for (let i = 0; i < standings.length; i++) {
        for (let j = 0; j < i; j++) {
          // Second fixture: reverse home/away.
          simulateMatch(standings[j], standings[i]);
        }
      }
      
      standings.sort((a, b) => {
        if (b.pts !== a.pts) return b.pts - a.pts;
        let gdA = a.gf - a.ga, gdB = b.gf - b.ga;
        if (gdB !== gdA) return gdB - gdA;
        return b.gf - a.gf;
      });

      const [season, game, version] = seasons[round];
      const myTeam = standings.find(t => t.isPlayer);
      const myPos = standings.findIndex(t => t.isPlayer) + 1;
      const myOvr = getLiveOvr();

      if (myPos === 1) {
        unlockAchievement("league_champion");
        let signings = selections.filter(p => !p.is_default).length;
        if (signings === 0) unlockAchievement("in_a_pinch");
        if (seasonResults.length > 0) {
          let prev = seasonResults[seasonResults.length - 1];
          if (prev.pos >= 18) unlockAchievement("kaiserslaughter");
        }
      }
      if (myTeam && myTeam.l === 0) {
        unlockAchievement("invincibles");
      }
      seasonResults.push({ season, game, pos: myPos, ovr: myOvr });

      renderStandings("End of Season Results", "Continue", "endSimulation()", true);
    }

    function renderStandings(title, buttonText, buttonAction, showScorer = false) {
      const standings = currentSeasonStandings;
      standings.sort((a, b) => {
        if (b.pts !== a.pts) return b.pts - a.pts;
        let gdA = a.gf - a.ga, gdB = b.gf - b.ga;
        if (gdB !== gdA) return gdB - gdA;
        return b.gf - a.gf;
      });

      const [season, game] = seasons[round];
      document.getElementById("simKicker").textContent = `${season}`;
      document.getElementById("simTitle").textContent = title;

      const playerTeamName = getCurrentPlayerTeamName();
      const playerRow = standings.find(t => t.isPlayer);
      const playerPos = standings.findIndex(t => t.isPlayer) + 1;
      // Give the newspaper a stronger editorial reaction based on where the
      // team actually finished, rather than simply printing the position.
      const headline = showScorer
        ? (
            playerPos === 1
              ? `${playerTeamName} Take the Crown`
              : playerPos <= 3
                ? `${playerTeamName} Challenge`
                : playerPos <= 6
                  ? `${playerTeamName} Impress`
                  : playerPos <= 9
                    ? `${playerTeamName} Surprise`
                    : playerPos <= 13
                      ? `${playerTeamName} Flounder`
                      : playerPos <= 17
                        ? `${playerTeamName} Disappoint`
                        : `${playerTeamName} Flop`
          )
        : `It's Christmas for ${playerTeamName}`;
      const deck = playerRow
        ? ``
        : "";

      const headlineEl = document.getElementById("newsHeadline");
      const deckEl = document.getElementById("newsDeck");
      if (headlineEl) headlineEl.textContent = headline;
      if (deckEl) deckEl.textContent = deck;

      document.getElementById("leagueTableBody").innerHTML = standings.map((t, idx) => `
        <tr style="${t.isPlayer ? 'background:#e8f4e8; font-weight:bold; border-left:3px solid #2c7a2c;' : ''}">
          <td>${idx + 1}</td>
          <td>${t.team}</td>
          <td>${t.p}</td>
          <td>${t.w}</td>
          <td>${t.d}</td>
          <td>${t.l}</td>
          <td>${t.gf}</td>
          <td>${t.ga}</td>
          <td>${t.gf - t.ga > 0 ? '+' + (t.gf - t.ga) : t.gf - t.ga}</td>
          <td><strong>${t.pts}</strong></td>
        </tr>
      `).join("");

      document.querySelector("#simulation .actions").innerHTML = `<button class="primary" onclick="${buttonAction}">${buttonText}</button>`;
      
      if (showScorer) {
        let topScorer = null;
        let maxGoals = 0;
        for (let i = 0; i < 11; i++) {
          if (placements[i] && placements[i].seasonGoals > maxGoals) {
            maxGoals = placements[i].seasonGoals;
            topScorer = placements[i];
          }
        }
        const teamGoals = standings.find(t => t.isPlayer).gf;
        let goalHtml = "";
        if (topScorer) {
           let scorerName = getPlayerCode(topScorer);
           goalHtml = `<div style="margin-top:20px; padding:15px; border:1px solid #2c2c2c; border-radius:5px; background:#fffdfa;">
             <div class="kicker">Team Stats</div>
             <div style="display:flex; justify-content:space-between; align-items:center;">
               <div>
                 <h3 style="margin:5px 0; font-family:Georgia, serif; font-size:22px;">${scorerName}</h3>
                 <p style="font-family:monospace; margin:0; font-size:12px; color:#555;">${topScorer.position} - Top Goalscorer</p>
               </div>
               <div style="text-align:right;">
                 <div style="font-family:Georgia, serif; font-size:28px; font-weight:bold;">${maxGoals}</div>
                 <div style="font-family:monospace; font-size:10px; color:#666;">GOALS</div>
               </div>
             </div>
             <div style="margin-top:15px; padding-top:10px; border-top:1px dashed #ccc; font-family:monospace; font-size:11px; color:#555; text-align:center;">
               Team Total: ${teamGoals} goals
             </div>
           </div>`;
        }
        document.getElementById("goalscorersUI").innerHTML = goalHtml;
      } else {
        document.getElementById("goalscorersUI").innerHTML = "";
      }

      show("simulation");
    }

    function shuffleArray(arr) {
      const a = [...arr];
      for (let i = a.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [a[i], a[j]] = [a[j], a[i]];
      }
      return a;
    }

    function getCurrentPlayerTeamName() {
      const input = document.getElementById("teamName");
      return input ? (input.value.trim() || "The Vision FC") : "The Vision FC";
    }

    function simulateUCLMatch(teamA, teamB, twoLegs = true) {
      const a = { ...teamA };
      const b = { ...teamB };

      function simulateLeg(home, away) {
        const D = home.ovr - away.ovr;
        const lambdaHome = 1.35 * Math.exp(D / 60) + 0.25;
        const lambdaAway = 1.35 * Math.exp(-D / 60);
        return {
          home: samplePoisson(lambdaHome),
          away: samplePoisson(lambdaAway)
        };
      }

      function simulatePenalties() {
        let scoreA = 0;
        let scoreB = 0;
        for (let i = 0; i < 5; i++) {
          if (Math.random() < 0.7) scoreA++;
          if (Math.random() < 0.7) scoreB++;
        }
        while (scoreA === scoreB) {
          if (Math.random() < 0.7) scoreA++;
          if (Math.random() < 0.7) scoreB++;
        }
        return { scoreA, scoreB };
      }

      if (!twoLegs) {
        const leg = simulateLeg(a, b);
        let winner, decidedBy = "", pens = null;

        if (leg.home > leg.away) winner = a;
        else if (leg.away > leg.home) winner = b;
        else {
          decidedBy = "p";
          pens = simulatePenalties();
          winner = pens.scoreA > pens.scoreB ? a : b;
        }

        return {
          teamA: a, teamB: b,
          leg1: leg, leg2: null,
          aggregateA: leg.home, aggregateB: leg.away,
          winner: { ...winner, decidedBy },
          pens
        };
      }

      const leg1 = simulateLeg(a, b);
      const leg2Raw = simulateLeg(b, a);
      const leg2 = { home: leg2Raw.home, away: leg2Raw.away };

      const aggregateA = leg1.home + leg2.away;
      const aggregateB = leg1.away + leg2.home;

      let winner, decidedBy = "", pens = null;
      if (aggregateA > aggregateB) winner = a;
      else if (aggregateB > aggregateA) winner = b;
      else {
        decidedBy = Math.random() < 0.5 ? "p" : "p";
        if (decidedBy === "p") {
          pens = simulatePenalties();
          winner = pens.scoreA > pens.scoreB ? a : b;
        } else {
          winner = Math.random() < 0.5 ? a : b;
        }
      }

      return {
        teamA: a, teamB: b,
        leg1, leg2,
        aggregateA, aggregateB,
        winner: { ...winner, decidedBy },
        pens
      };
    }

    /*
     * UCL BRACKET ORDER
     * -----------------
     * There are two fundamentally different operations here:
     *
     *  1. DRAW a round: randomisation is allowed.
     *  2. ADVANCE a round: randomisation is NEVER allowed.
     *
     * The old implementation used shuffleArray() every time matchups were
     * created. That meant the eight play-off winners could be shuffled before
     * entering the Round of 16, breaking the visual bracket path.
     *
     * Every match now has a permanent `bracketSlot`. A winner inherits the
     * slot/path of the match it came from, and the next round pairs adjacent
     * slots: 0+1, 2+3, 4+5, 6+7, etc.
     */

    function createUCLMatch(teamA, teamB, bracketSlot, roundKey) {
      const match = simulateUCLMatch(teamA, teamB, true);

      if (!match) return null;

      match.bracketSlot = bracketSlot;
      match.roundKey = roundKey;

      return match;
    }

    // Used only for the initial draw of a bracket round.
    function drawUCLMatchups(teamsA, teamsB, roundKey) {
      const a = shuffleArray(teamsA).filter(Boolean);
      const b = shuffleArray(teamsB).filter(Boolean);

      if (a.length !== b.length) {
        console.error("UCL matchup size mismatch:", {
          roundKey,
          sideA: a,
          sideB: b
        });
        return [];
      }

      return a
        .map((team, i) => {
          const opponent = b[i];
          if (!team || !opponent) return null;

          // This slot is now permanent. Nothing in later rounds is allowed
          // to reshuffle it.
          return createUCLMatch(team, opponent, i, roundKey);
        })
        .filter(Boolean);
    }

    // Used whenever teams are ALREADY in bracket order. Never shuffle here.
    function makeFixedUCLMatchups(teamsA, teamsB, roundKey) {
      const a = teamsA.filter(Boolean);
      const b = teamsB.filter(Boolean);

      if (a.length !== b.length) {
        console.error("UCL fixed matchup size mismatch:", {
          roundKey,
          sideA: a,
          sideB: b
        });
        return [];
      }

      return a
        .map((team, i) => {
          const opponent = b[i];
          if (!team || !opponent) return null;

          return createUCLMatch(team, opponent, i, roundKey);
        })
        .filter(Boolean);
    }

    function pairWinnerMatches(matches, roundKey) {
      // Sort by the permanent slot, rather than trusting array order.
      // This makes the bracket robust even if the matches are later stored,
      // rendered, or passed around in a different array order.
      const orderedMatches = (matches || [])
        .filter(Boolean)
        .slice()
        .sort((a, b) => Number(a.bracketSlot) - Number(b.bracketSlot));

      const winners = orderedMatches
        .map(m => m?.winner)
        .filter(Boolean);

      if (winners.length < 2 || winners.length % 2 !== 0) {
        console.error(
          "Invalid UCL winner count for next round:",
          winners.length,
          winners
        );
        return [];
      }

      const out = [];

      for (let i = 0; i < winners.length; i += 2) {
        // The new slot is based on the path, not on a new random draw.
        out.push(
          createUCLMatch(
            winners[i],
            winners[i + 1],
            i / 2,
            roundKey
          )
        );
      }

      return out.filter(Boolean);
    }

    function renderUCLMatch(match, twoLegs = true, showScores = true) {
      if (!match?.teamA?.team || !match?.teamB?.team || !match?.winner?.team) {
        console.error("Skipping malformed UCL match:", match);
        return `
          <div class="uclMatch">
            <div class="uclTeam"><div class="uclTeamName">MATCH DATA ERROR</div></div>
          </div>`;
      }

      const a = match.teamA, b = match.teamB;
      const winnerName = match.winner?.team;
      const playerName = getCurrentPlayerTeamName();

      const aWinner = showScores && winnerName === a.team;
      const bWinner = showScores && winnerName === b.team;
      const aPlayer = a.team === playerName;
      const bPlayer = b.team === playerName;

      const aLeg1 = showScores ? match.leg1.home : "-";
      const bLeg1 = showScores ? match.leg1.away : "-";
      const aLeg2 = twoLegs ? (showScores ? match.leg2.away : "-") : "";
      const bLeg2 = twoLegs ? (showScores ? match.leg2.home : "-") : "";
      const aggA = showScores ? match.aggregateA : "-";
      const aggB = showScores ? match.aggregateB : "-";
      
      let pA = "", pB = "";
      if (showScores && match.pens) {
        pA = ` <span style="font-size:9px;color:#888;">(${match.pens.scoreA})</span>`;
        pB = ` <span style="font-size:9px;color:#888;">(${match.pens.scoreB})</span>`;
      }

      const note = showScores && match.winner?.decidedBy
        ? `<div style="padding:3px 6px;font-size:9px;color:#666;font-family:monospace;">Decided ${match.winner.decidedBy}</div>`
        : "";

      return `
    <div class="uclMatch">
      <div class="uclTeam ${aWinner ? "uclWinner" : ""}">
        <div class="uclTeamName ${aPlayer ? "playerTeam" : ""}" title="${a.team}">${a.team}</div>
        <div class="uclScore">${aLeg1}</div>
        <div class="uclScore">${aLeg2}</div>
        <div class="uclScore uclAggregate">${aggA}${pA}</div>
      </div>
      <div class="uclTeam ${bWinner ? "uclWinner" : ""}">
        <div class="uclTeamName ${bPlayer ? "playerTeam" : ""}" title="${b.team}">${b.team}</div>
        <div class="uclScore">${bLeg1}</div>
        <div class="uclScore">${bLeg2}</div>
        <div class="uclScore uclAggregate">${aggB}${pB}</div>
      </div>
      ${note}
    </div>
  `;
    }

    function renderUCLRound(title, matches, twoLegs = true, showScores = true) {
      const header = twoLegs
        ? `<div class="uclRoundTitle">${title}<div style="font-family:monospace;font-size:8px;color:#666;margin-top:2px;">LEG 1 · LEG 2 · AGG</div></div>`
        : `<div class="uclRoundTitle">${title}<div style="font-family:monospace;font-size:8px;color:#666;margin-top:2px;">FINAL</div></div>`;

      return `
    <div class="uclRound">
      ${header}
      <div class="uclMatches">
        ${matches.map(m => renderUCLMatch(m, twoLegs, showScores)).join("")}
      </div>
    </div>
  `;
    }

    let currentUCLData = null;
    let currentUCLStep = 0;
    let uclScoresRevealed = false;

    function renderUCLStep() {
      const data = currentUCLData;
      if (!data?.champion?.team) {
        console.error("Cannot render UCL: invalid tournament data", data);
        document.getElementById("uclStatus").textContent = "Error";
        document.getElementById("uclSummary").innerHTML = `
          <div class="score" style="margin:20px 0;">
            <small>TOURNAMENT DATA ERROR</small>
            <p style="margin:10px 0 0;color:#a00;font-family:monospace;font-size:11px;">
              The Champions League bracket could not be constructed. No undefined teams were inserted.
            </p>
          </div>`;
        document.getElementById("uclBracket").innerHTML = "";
        document.querySelector("#ucl .actions").innerHTML = `<button class="primary" onclick="continueAfterUCL()">Continue</button>`;
        return;
      }

      const playerTeam = getCurrentPlayerTeamName();
      const playerWon = data.champion.team === playerTeam;
      const latest = seasonResults[seasonResults.length - 1];

      let rounds = [];
      if (data.hasPlayoff) rounds.push({ name: "Knockout phase play-offs", matches: data.playoffMatches, twoLegs: true });
      rounds.push({ name: "Round of 16", matches: data.round16Matches, twoLegs: true });
      rounds.push({ name: "Quarter-finals", matches: data.quarterMatches, twoLegs: true });
      rounds.push({ name: "Semi-finals", matches: data.semiMatches, twoLegs: true });
      rounds.push({ name: "Final", matches: [data.finalMatch], twoLegs: false });

      let playerEliminated = false;
      for (let i = 0; i <= currentUCLStep; i++) {
        if (i === currentUCLStep && !uclScoresRevealed) continue;
        let match = rounds[i].matches.find(m => m.teamA.team === playerTeam || m.teamB.team === playerTeam);
        if (match && match.winner.team !== playerTeam) {
          playerEliminated = true;
        }
      }

      const isComplete = currentUCLStep === rounds.length - 1 && uclScoresRevealed;

      document.getElementById("uclTitle").textContent = `${data.season} · UEFA Champions League`;

      let statusText = "In Progress";
      if (isComplete) {
        statusText = playerWon ? "Champions" : "Eliminated";
      } else if (playerEliminated) {
        statusText = "Eliminated";
      }
      document.getElementById("uclStatus").textContent = statusText;

      let resultText = "Tournament in progress...";
      if (isComplete) {
        resultText = data.champion.team;
      } else if (playerEliminated) {
        resultText = `Eliminated in ${data.eliminatedRound}.`;
      }

      document.getElementById("uclSummary").innerHTML = `
    <div class="uclSummary">
      <div class="uclSummaryCard">
        <small>Your league finish</small>
        <strong>${latest.pos}${latest.pos === 1 ? "st" : latest.pos === 2 ? "nd" : latest.pos === 3 ? "rd" : "th"}</strong>
      </div>
      <div class="uclSummaryCard">
        <small>Your team</small>
        <strong>${playerTeam}</strong>
      </div>
      <div class="uclSummaryCard">
        <small>Winner</small>
        <strong>${resultText}</strong>
      </div>
    </div>
  `;

      let visibleRounds = rounds.slice(0, currentUCLStep + 1);

      document.getElementById("uclBracket").innerHTML = `
    <div class="uclRounds ${data.hasPlayoff ? "" : "noPlayoff"}">
      ${visibleRounds.map((r, i) => renderUCLRound(r.name, r.matches, r.twoLegs, i < currentUCLStep || uclScoresRevealed)).join("")}
    </div>
  `;

      let actionsHtml = "";
      if (isComplete) {
        actionsHtml = `<button class="primary" onclick="continueAfterUCL()">Continue</button>`;
      } else if (playerEliminated) {
        actionsHtml = `<button class="primary" onclick="showFinalBracket()">Show Final Bracket</button>`;
      } else if (!uclScoresRevealed) {
        actionsHtml = `<button class="primary" onclick="revealUCLScores()">Simulate Round</button>`;
      } else {
        actionsHtml = `<button class="primary" onclick="simulateNextUCLRound()">Next Round</button>`;
      }

      document.querySelector("#ucl .actions").innerHTML = actionsHtml;
    }
    
    function revealUCLScores() {
      uclScoresRevealed = true;
      renderUCLStep();
    }

    function simulateNextUCLRound() {
      currentUCLStep++;
      uclScoresRevealed = false;
      renderUCLStep();
    }

    function showFinalBracket() {
      let totalRounds = currentUCLData.hasPlayoff ? 5 : 4;
      currentUCLStep = totalRounds - 1;
      uclScoresRevealed = true;
      renderUCLStep();
    }

    function runUCLForCurrentSeason() {
      const [season, game] = seasons[round];
      const rows = (uclData[game] || []).map(t => ({ ...t }));
      const playerTeam = getCurrentPlayerTeamName();
      const playerOvr = getLiveOvr();
      const latest = seasonResults[seasonResults.length - 1];

      if (!latest || latest.pos > 4) return false;
      if (!rows.length) {
        console.warn(`No UCL data found for ${game}`);
        return false;
      }

      const isNewFormat = game === "FC 26" || game === "FC 27";
      const expectedTotal = isNewFormat ? 24 : 16;
      const expectedR = 8;
      const expectedIR = 8;
      const expectedP = isNewFormat ? 8 : 0;

      // Validate the loaded CSV before constructing the bracket. This catches
      // bad data without ever allowing an undefined team into the UI.
      const sourceCounts = rows.reduce((acc, row) => {
        acc[row.role] = (acc[row.role] || 0) + 1;
        return acc;
      }, {});

      if (
        rows.length !== expectedTotal ||
        Number(sourceCounts.r || 0) !== expectedR ||
        Number(sourceCounts.ir || 0) !== expectedIR ||
        Number(sourceCounts.p || 0) !== expectedP
      ) {
        console.error("Invalid UCL source data:", {
          game,
          expected: { total: expectedTotal, r: expectedR, ir: expectedIR, p: expectedP },
          actual: sourceCounts,
          rows
        });
        return false;
      }

      const playerRow = rows.find(t => t.team === playerTeam) || null;
      const playerOriginalRole = playerRow?.role || "r";

      const availableR = rows.filter(t => t.team !== playerTeam && t.role === "r");
      const availableIR = rows.filter(t => t.team !== playerTeam && t.role === "ir");
      const protectedP = rows.filter(t => t.team !== playerTeam && t.role === "p");

      const playerEntry = {
        team: playerTeam,
        ovr: playerOvr,
        role: playerOriginalRole,
        isPlayer: true
      };

      // Replace a team from the player's ORIGINAL CSV role.
      // This fixes the previous undefined-team bug when the user's team was
      // one of the eight protected FC26/FC27 teams.
      function replaceRandomTeam(pool, replacement) {
        if (!pool.length) return false;
        pool[Math.floor(Math.random() * pool.length)] = replacement;
        return true;
      }

      if (playerOriginalRole === "ir") {
        replaceRandomTeam(availableIR, playerEntry);
      } else if (playerOriginalRole === "p" && isNewFormat) {
        replaceRandomTeam(protectedP, playerEntry);
      } else {
        replaceRandomTeam(availableR, playerEntry);
      }

      // Refuse to render a broken bracket.
      if (
        availableR.length !== expectedR ||
        availableIR.length !== expectedIR ||
        (isNewFormat && protectedP.length !== expectedP)
      ) {
        console.error("UCL bracket construction failed:", {
          game,
          playerTeam,
          playerOriginalRole,
          r: availableR.length,
          ir: availableIR.length,
          p: protectedP.length
        });
        return false;
      }

      let playoffMatches = [];
      let round16Matches;
      let eliminatedRound = null;

      function checkEliminatedRound(matches, roundName) {
        if (eliminatedRound) return;
        const playerMatch = (matches || []).find(m =>
          m?.teamA?.team === playerTeam || m?.teamB?.team === playerTeam
        );
        if (playerMatch && playerMatch.winner?.team !== playerTeam) {
          eliminatedRound = roundName;
        }
      }

      if (isNewFormat) {
        // ---------------------------------------------------------------
        // KNOCKOUT PHASE PLAY-OFFS (the new-format R32 stage)
        // ---------------------------------------------------------------
        // This is the ONLY place where the initial R32 draw is randomised.
        playoffMatches = drawUCLMatchups(
          availableR,
          availableIR,
          "playoffs"
        );

        if (playoffMatches.length !== 8) {
          console.error("UCL play-off construction failed.", playoffMatches);
          return false;
        }

        checkEliminatedRound(playoffMatches, "Play-offs");

        // Keep the winners in their exact play-off slots.
        //
        // R32 slot 0 -> R16 slot 0
        // R32 slot 1 -> R16 slot 1
        // ...
        // R32 slot 7 -> R16 slot 7
        //
        // No shuffle is performed here.
        const playoffWinners = playoffMatches
          .slice()
          .sort((a, b) => a.bracketSlot - b.bracketSlot)
          .map(m => m.winner)
          .filter(Boolean);

        // `protectedP` is also placed into fixed slots. Its order is the
        // order supplied by the UCL data after the initial team replacement.
        // It is intentionally NOT shuffled at this stage.
        const protectedTeamsInBracketOrder = protectedP
          .filter(Boolean);

        round16Matches = makeFixedUCLMatchups(
          playoffWinners,
          protectedTeamsInBracketOrder,
          "round16"
        );

        if (round16Matches.length !== 8) {
          console.error("UCL Round-of-16 construction failed.", round16Matches);
          return false;
        }

        checkEliminatedRound(round16Matches, "Round of 16");
      } else {
        // Old-format seasons have no play-off stage. The R16 draw happens
        // once here and then becomes the permanent bracket.
        round16Matches = drawUCLMatchups(
          availableR,
          availableIR,
          "round16"
        );

        if (round16Matches.length !== 8) {
          console.error("UCL Round-of-16 construction failed.", round16Matches);
          return false;
        }

        checkEliminatedRound(round16Matches, "Round of 16");
      }

      // From this point onward the bracket is completely deterministic:
      // adjacent winners always remain on the same side of the bracket.
      const quarterMatches = pairWinnerMatches(
        round16Matches,
        "quarterfinals"
      );
      if (quarterMatches.length !== 4) return false;
      checkEliminatedRound(quarterMatches, "Quarter-finals");

      const semiMatches = pairWinnerMatches(
        quarterMatches,
        "semifinals"
      );
      if (semiMatches.length !== 2) return false;
      checkEliminatedRound(semiMatches, "Semi-finals");

      if (!semiMatches[0]?.winner || !semiMatches[1]?.winner) {
        console.error("UCL final could not be constructed.", semiMatches);
        return false;
      }

      const finalMatch = simulateUCLMatch(
        semiMatches[0].winner,
        semiMatches[1].winner,
        false
      );
      if (finalMatch) {
        finalMatch.bracketSlot = 0;
        finalMatch.roundKey = "final";
      }
      if (!finalMatch?.winner) {
        console.error("UCL final simulation failed.", finalMatch);
        return false;
      }
      checkEliminatedRound([finalMatch], "Final");

      const champion = finalMatch.winner;

      currentUCLData = {
        season,
        game,
        playoffMatches,
        round16Matches,
        quarterMatches,
        semiMatches,
        finalMatch,
        champion,
        hasPlayoff: isNewFormat,
        eliminatedRound,

        // The knockout rounds above already contain permanent bracketSlot
        // values. Keeping the complete path here makes the rendered bracket
        // independent of any later array ordering.
        bracketOrder: {
          playoffs: playoffMatches.map(m => m.bracketSlot),
          round16: round16Matches.map(m => m.bracketSlot),
          quarterfinals: quarterMatches.map(m => m.bracketSlot),
          semifinals: semiMatches.map(m => m.bracketSlot),
          final: finalMatch.bracketSlot
        }
      };

      latest.ucl = {
        qualified: true,
        champion: champion.team,
        playerChampion: champion.team === playerTeam,
        eliminatedRound: eliminatedRound || null
      };

      if (champion.team === playerTeam) {
        unlockAchievement("ucl_champion");
        let uclWinsInRow = 0;
        for (let i = seasonResults.length - 1; i >= 0; i--) {
          if (seasonResults[i].ucl && seasonResults[i].ucl.playerChampion) uclWinsInRow++;
          else break;
        }
        if (uclWinsInRow >= 3) {
          unlockAchievement("threepeat");
        }
      }

      currentUCLStep = 0;
      uclScoresRevealed = false;
      renderUCLStep();

      return true;
    }

    function showNoUCL() {
      const [season, game] = seasons[round];
      const latest = seasonResults[seasonResults.length - 1];
      const playerTeam = getCurrentPlayerTeamName();

      document.getElementById("uclTitle").textContent = `${season} · UEFA Champions League`;
      document.getElementById("uclStatus").textContent = "Not Qualified";
      document.getElementById("uclSummary").innerHTML = `
    <div class="score" style="margin:20px 0;">
      <small>LEAGUE FINISH</small>
      <strong style="font-size:48px;">${latest.pos}${latest.pos === 1 ? "st" : latest.pos === 2 ? "nd" : latest.pos === 3 ? "rd" : "th"}</strong>
      <p style="margin:10px 0 0;color:#666;font-family:monospace;font-size:11px;">
        ${playerTeam} did not qualify for the Champions League this season.
      </p>
    </div>
  `;
      document.getElementById("uclLegend").textContent = "";
      document.getElementById("uclBracket").innerHTML = "";
    }

    function endSimulation() {
      // The UCL is played immediately after the corresponding PL season.
      const playedUCL = runUCLForCurrentSeason();

      if (playedUCL) {
        document.getElementById("status").textContent = "Champions League";
        show("ucl");
        return;
      }

      // Still show a season-specific UCL result screen even when the player
      // finishes outside the top four.
      showNoUCL();
      document.getElementById("status").textContent = "Champions League";
      document.querySelector("#ucl .actions").innerHTML =
        `<button class="primary" onclick="continueAfterUCL()">Continue</button>`;
      show("ucl");
    }

    let pendingInjurySlot = null;
    let pendingInjuryPlayer = null;
    let pendingInjuryReplacement = null;
    let pendingInjuryCandidates = [];

    function getMasterPlayers() {
      if (!allPlayers) return [];
      return Array.isArray(allPlayers.players)
        ? allPlayers.players
        : Object.values(allPlayers.players || {});
    }

    function buildInjuryReplacementCandidate(masterPlayer) {
      const nextRoundIndex = Math.min(round + 1, FINAL_SEASON_INDEX);
      const nextSeason = seasons[nextRoundIndex];
      const version = nextSeason[2];
      const real = realPlayer(masterPlayer) || masterPlayer;

      return {
        ...masterPlayer,
        player_id: masterPlayer.player_id ?? masterPlayer.id,
        position: masterPlayer.position,
        anonymous_id: getPlayerCode(masterPlayer),
        club: masterPlayer.club || (masterPlayer.season_stats
          ? Object.values(masterPlayer.season_stats)[0]?.club
          : "Unknown"),
        overall: getHistoryValue(real?.overall_history, version) ?? getCurrentOvr(masterPlayer, version),
        potential: real?.potential_history
          ? (getHistoryValue(real.potential_history, version) ?? getHistoryValue(real.overall_history, version))
          : (masterPlayer.potential ?? getHistoryValue(real?.overall_history, version)),
        age: getPlayerAge(masterPlayer, nextRoundIndex),
        season: nextSeason[1],
        game: nextSeason[0],
        version,
        price: 0,
        is_injury_replacement: true
      };
    }

    function getEligibleInjuryReplacements() {
      const occupied = new Set(
        Object.values(placements)
          .filter(Boolean)
          .map(p => String(p.player_id))
      );

      const unavailable = new Set(used);
      if (pendingInjuryPlayer?.player_id != null) {
        unavailable.add(String(pendingInjuryPlayer.player_id));
      }

      const injuredPosition = String(pendingInjuryPlayer?.position || "")
        .trim()
        .toUpperCase();

      if (!injuredPosition) return [];

      const candidates = getMasterPlayers().filter(p => {
        if (!p) return false;
        const id = p.player_id ?? p.id;
        if (id == null) return false;
        if (unavailable.has(String(id))) return false;
        if (occupied.has(String(id))) return false;

        const position = String(p.position || "").trim().toUpperCase();
        if (position !== injuredPosition) return false;

        if (p.injured_until != null && Number(p.injured_until) >= round + 1) {
          return false;
        }

        return true;
      });

      // Sample from the full ~1600-player master database, then offer only
      // three random candidates to the manager.
      return shuffleArray(candidates)
        .slice(0, 3)
        .map(buildInjuryReplacementCandidate);
    }

    function showInjuryReplacement(slotIndex, injuredPlayer) {
      pendingInjurySlot = slotIndex;
      pendingInjuryPlayer = injuredPlayer;
      pendingInjuryReplacement = null;
      pendingInjuryCandidates = getEligibleInjuryReplacements();

      const area = document.getElementById('injuryReplacementArea');
      const button = document.getElementById('injuryConfirmButton');

      document.getElementById('injuryMessage').innerText =
        `Oh no! ${"Player " + getPlayerCode(injuredPlayer)} was injured and will miss the entire next campaign. Select a replacement before continuing.`;

      if (!pendingInjuryCandidates.length) {
        area.innerHTML = `<div class="note" style="color:#a00;font-weight:bold;">No eligible ${injuredPlayer.position || ''} replacement is available. The season cannot continue with fewer than 11 players.</div>`;
        button.disabled = true;
        button.textContent = 'No Replacement Available';
      } else {
        area.innerHTML = `
          <div style="font-weight:800;font-size:11px;text-transform:uppercase;letter-spacing:1px;margin-bottom:8px;">${injuredPlayer.position || 'Position'} Replacement</div>
          <div style="display:grid;gap:7px;max-height:220px;overflow:auto;">
            ${pendingInjuryCandidates.map((p, i) => `
              <button type="button" class="secondary injuryReplacementOption" data-index="${i}" onclick="selectInjuryReplacement(${i})" style="text-align:left;width:100%;">
                ${getPlayerCode(p)} · ${p.position || 'N/A'} · OVR ${getCurrentOvr(p, p.version)}
              </button>
            `).join('')}
          </div>
        `;
        button.disabled = true;
        button.textContent = 'Select a Replacement';
        button.style.cursor = 'not-allowed';
      }

      document.getElementById('injuryModal').style.display = 'block';
    }

    function selectInjuryReplacement(index) {
      const p = pendingInjuryCandidates[index];
      if (!p) return;

      pendingInjuryReplacement = p;
      document.querySelectorAll('.injuryReplacementOption').forEach((button, i) => {
        const selected = i === index;
        button.style.background = selected ? 'var(--ink)' : '';
        button.style.color = selected ? 'var(--paper)' : '';
      });

      const button = document.getElementById('injuryConfirmButton');
      button.disabled = false;
      button.textContent = `Confirm ${getPlayerCode(p)} as Replacement`;
      button.style.cursor = 'pointer';
    }

    async function confirmInjuryReplacement() {
      if (pendingInjurySlot == null || !pendingInjuryReplacement) return;

      const replacement = pendingInjuryReplacement;
      const replacedSlot = pendingInjurySlot;
      const [nextSeason] = seasons[Math.min(round + 1, FINAL_SEASON_INDEX)];

      // The replacement occupies the exact same tactical slot and becomes a
      // real signing in this career, preventing it from being offered again.
      selections.push(replacement);
      used.add(String(replacement.player_id));
      placements[replacedSlot] = replacement;

      try {
        await recordPlayerSigning(replacement, nextSeason);
      } catch (e) {
        console.error("Injury replacement signing save failed:", e);
        selections.pop();
        used.delete(String(replacement.player_id));
        placements[replacedSlot] = pendingInjuryPlayer;
        alert("The replacement could not be saved. Please try again.");
        return;
      }

      pendingInjurySlot = null;
      pendingInjuryPlayer = null;
      pendingInjuryReplacement = null;
      pendingInjuryCandidates = [];

      document.getElementById('injuryModal').style.display = 'none';
      document.getElementById('injuryReplacementArea').innerHTML = '';
      const button = document.getElementById('injuryConfirmButton');
      button.disabled = true;
      button.textContent = 'Select Replacement';
      button.style.cursor = 'pointer';
      updateLiveStats();
      renderPitch();
      renderSquad();

      advanceAfterUCL();
    }

    function continueAfterUCL() {
      if (round < FINAL_SEASON_INDEX && Math.random() < 0.10) {
        const active = [];
        for (let i = 0; i < 11; i++) if (placements[i]) active.push(i);

        if (active.length === 11) {
          const i = active[Math.floor(Math.random() * active.length)];
          const p = placements[i];
          p.injured_until = round + 1;
          placements[i] = null;
          showInjuryReplacement(i, p);
          return;
        }
      }

      advanceAfterUCL();
    }

    function advanceAfterUCL() {
      // Never advance into another season with fewer than 11 players.
      const xiCount = Array.from({ length: 11 }, (_, i) => placements[i]).filter(Boolean).length;
      if (xiCount !== 11) {
        alert('You must have 11 players in your XI before continuing.');
        return;
      }

      const latest = seasonResults[seasonResults.length - 1];
      let uclEarnings = 0;
      if (latest.ucl && latest.ucl.qualified) {
        if (latest.ucl.playerChampion) uclEarnings = 75000000;
        else if (latest.ucl.eliminatedRound === "Final") uclEarnings = 60000000;
        else if (latest.ucl.eliminatedRound === "Semi-finals") uclEarnings = 50000000;
        else if (latest.ucl.eliminatedRound === "Quarter-finals") uclEarnings = 30000000;
        else if (latest.ucl.eliminatedRound === "Round of 16") uclEarnings = 25000000;
        else uclEarnings = 15000000;
      }
      budget += uclEarnings;

      round++;
      nextRound();
    }

    function samplePoisson(lambda) {
      let L = Math.exp(-lambda), p = 1.0, k = 0;
      do { k++; p *= Math.random(); } while (p > L);
      return k - 1;
    }

    function openHelp() {
      const modal = document.getElementById("helpModal");
      if (!modal) return;
      modal.style.display = "flex";
      document.body.style.overflow = "hidden";
    }

    function closeHelp() {
      const modal = document.getElementById("helpModal");
      if (!modal) return;
      modal.style.display = "none";
      document.body.style.overflow = "";
    }

    document.addEventListener("keydown", (e) => {
      if (e.key === "Escape") closeHelp();
    });

    checkAuth();
