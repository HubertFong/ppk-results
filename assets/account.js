/* The PPK member account page: magic-link sign-in, the member's profile, and
 * their achievement awards.
 *
 * A classic script, loaded at the end of the body by site_account.py, so every
 * element below already exists when it runs. Its only dependency is the
 * global `supabase` from the pinned supabase-js tag on the same page.
 * Config comes from #account-root's data attributes, never from inline text.
 */
(function () {
  "use strict";

  // Turnstile's script is deferred and calls these later, so they have to be
  // on window from this script's first synchronous run.
  var captchaToken = null;
  window.ppkTurnstileSuccess = function (token) { captchaToken = token; };
  window.ppkTurnstileExpired = function () { captchaToken = null; };

  // The columns of `profiles`, in the order the form shows them. The labels
  // are the form's own labels, reused in the validation messages.
  var PROFILE_FIELDS = [
    { column: "full_name", label: "Full name", kind: "text", maxLength: 120 },
    { column: "preferred_name", label: "Preferred name", kind: "text", maxLength: 60 },
    { column: "date_of_birth", label: "Date of birth", kind: "date" },
    { column: "gender", label: "Gender", kind: "text", maxLength: 40 },
    { column: "phone", label: "Phone", kind: "text", maxLength: 32 },
    { column: "club", label: "Club", kind: "text", maxLength: 120 },
    { column: "years_riding", label: "Years riding", kind: "number" },
    { column: "kit_size", label: "Kit size", kind: "text", maxLength: 20 },
    { column: "bike_type", label: "Bike type", kind: "text", maxLength: 60 },
    { column: "whatsapp_opt_in", label: "PPK may contact me on WhatsApp", kind: "checkbox" },
    { column: "email_opt_in", label: "PPK may contact me by email", kind: "checkbox" }
  ];
  var PROFILE_COLUMNS = PROFILE_FIELDS.map(function (field) { return field.column; });
  var PROFILE_SELECT = PROFILE_COLUMNS.join(", ");
  var ACHIEVEMENT_SELECT =
    "granted_at, achievement_definitions(label, description, display_order)";
  var OLDEST_BIRTH_DATE = "1900-01-01";

  var rootEl = document.getElementById("account-root");
  var formEl = document.getElementById("account-form");
  var emailEl = document.getElementById("account-email");
  var sendButton = document.getElementById("account-send");
  var sentEl = document.getElementById("account-sent");
  var sentEmailEl = document.getElementById("account-sent-email");
  var signedInEl = document.getElementById("account-signed-in");
  var userEmailEl = document.getElementById("account-user-email");
  var signOutButton = document.getElementById("account-signout");
  var errorEl = document.getElementById("account-error");
  var profileFormEl = document.getElementById("profile-form");
  var profileSaveButton = document.getElementById("profile-save");
  var profileStatusEl = document.getElementById("profile-status");
  var profileErrorEl = document.getElementById("profile-error");
  var achievementsListEl = document.getElementById("achievements-list");
  var achievementsEmptyEl = document.getElementById("achievements-empty");
  var achievementsErrorEl = document.getElementById("achievements-error");
  var organizerEl = document.getElementById("account-organizer");

  var client = supabase.createClient(rootEl.dataset.supabaseUrl, rootEl.dataset.supabaseKey);
  var captchaRequired = rootEl.dataset.captchaRequired === "true";

  var currentUser = null;   // the signed-in member, or null
  var loadedUserId = null;  // whose profile and achievements are already shown

  function clearChildren(el) {
    while (el.firstChild) el.removeChild(el.firstChild);
  }

  function profileInput(column) {
    return document.getElementById("profile-" + column);
  }

  function showError(message) {
    errorEl.textContent = "Something went wrong: " + message + ". Please try again in a moment.";
    errorEl.hidden = false;
  }

  // ------------------------------------------------------ sign in / out

  function safeReturnTo(raw) {
    if (!raw) return null;
    try {
      var target = new URL(raw, window.location.origin);
      if (target.origin !== window.location.origin || !target.pathname.startsWith("/")) return null;
      return target.pathname + target.search + target.hash;
    } catch (error) {
      return null;
    }
  }

  var accountUrl = new URL(window.location.href);
  var returnTo = safeReturnTo(accountUrl.searchParams.get("returnTo"));
  accountUrl.searchParams.delete("returnTo");
  if (returnTo) sessionStorage.setItem("ppkReturnTo", returnTo);

  function returnToSavedContext(session) {
    if (!session) return;
    var savedReturnTo = safeReturnTo(sessionStorage.getItem("ppkReturnTo"));
    if (savedReturnTo) {
      sessionStorage.removeItem("ppkReturnTo");
      window.location.assign(savedReturnTo);
    }
  }

  function render(session) {
    errorEl.hidden = true;
    if (session) {
      showSignedIn(session.user);
    } else {
      showSignedOut();
    }
  }

  function showSignedIn(user) {
    currentUser = user;
    formEl.hidden = true;
    sentEl.hidden = true;
    signedInEl.hidden = false;
    userEmailEl.textContent = user.email || "";
    // render() runs twice at start-up (getSession and INITIAL_SESSION), so
    // only the first one for this user id goes to the database.
    if (user.id === loadedUserId) return;
    loadedUserId = user.id;
    loadProfile(user.id);
    loadAchievements(user.id);
    checkOrganizer(user.id);
  }

  // Leaves nothing of the member's session on screen.
  function showSignedOut() {
    currentUser = null;
    loadedUserId = null;
    signedInEl.hidden = true;
    formEl.hidden = false;
    sentEl.hidden = true;
    profileFormEl.reset();
    profileStatusEl.textContent = "";
    clearProfileError();
    clearAchievementsError();
    clearChildren(achievementsListEl);
    achievementsEmptyEl.hidden = true;
    organizerEl.hidden = true;
  }

  // ---------------------------------------------------------- profile

  function clearProfileError() {
    profileErrorEl.textContent = "";
    profileErrorEl.hidden = true;
  }

  function showProfileError(message) {
    profileErrorEl.textContent = message;
    profileErrorEl.hidden = false;
  }

  // A null row means the member has no profile row yet: every field empty.
  function fillProfileForm(row) {
    PROFILE_FIELDS.forEach(function (field) {
      var input = profileInput(field.column);
      var value = row ? row[field.column] : null;
      if (field.kind === "checkbox") {
        input.checked = value === true;
      } else {
        input.value = (value === null || value === undefined) ? "" : String(value);
      }
    });
  }

  // A reply that arrives after sign-out, or after another member signed in,
  // must not put the earlier member's data back on screen.
  function stillShowing(userId) {
    return loadedUserId === userId;
  }

  function loadProfile(userId) {
    clearProfileError();
    profileStatusEl.textContent = "";
    client.from("profiles")
      .select(PROFILE_SELECT)
      .eq("user_id", userId)
      .maybeSingle()
      .then(function (res) {
        if (!stillShowing(userId)) return;
        if (res.error) {
          showProfileError("Couldn't load your profile: " + res.error.message);
          return;
        }
        fillProfileForm(res.data);
      });
  }

  function todayIso() {
    var now = new Date();
    var month = String(now.getMonth() + 1).padStart(2, "0");
    var day = String(now.getDate()).padStart(2, "0");
    return now.getFullYear() + "-" + month + "-" + day;
  }

  // True only for a real calendar day, so 2026-02-31 is rejected.
  function isRealDate(value) {
    var parts = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
    if (!parts) return false;
    var year = Number(parts[1]);
    var month = Number(parts[2]) - 1;
    var day = Number(parts[3]);
    var date = new Date(year, month, day);
    return date.getFullYear() === year && date.getMonth() === month && date.getDate() === day;
  }

  // Checks the eleven fields in form order and returns the first problem as
  // { input, message }, or null when every field is saveable.
  function firstProfileProblem() {
    for (var i = 0; i < PROFILE_FIELDS.length; i++) {
      var field = PROFILE_FIELDS[i];
      var input = profileInput(field.column);
      var value = input.value.trim();
      // Array.from counts characters as Postgres's char_length does; .length
      // would count an emoji twice.
      if (field.kind === "text" && Array.from(value).length > field.maxLength) {
        return { input: input,
                 message: field.label + " must be " + field.maxLength + " characters or fewer." };
      }
      if (field.kind === "number" && value !== "") {
        var years = Number(value);
        if (!Number.isInteger(years) || years < 0 || years > 100) {
          return { input: input,
                   message: field.label + " must be a whole number from 0 to 100." };
        }
      }
      if (field.kind === "date" && value !== "") {
        if (!isRealDate(value)) {
          return { input: input, message: field.label + " must be a real date, like 1990-04-23." };
        }
        if (value < OLDEST_BIRTH_DATE) {
          return { input: input, message: field.label + " can't be before 1 January 1900." };
        }
        if (value > todayIso()) {
          return { input: input, message: field.label + " can't be in the future." };
        }
      }
    }
    return null;
  }

  // Exactly the eleven profile columns plus user_id. The rest of the row is
  // not the member's to set from this page.
  function profilePayload(userId) {
    var payload = { user_id: userId };
    PROFILE_FIELDS.forEach(function (field) {
      var input = profileInput(field.column);
      if (field.kind === "checkbox") {
        payload[field.column] = input.checked;
        return;
      }
      var value = input.value.trim();
      if (value === "") {
        payload[field.column] = null;
      } else if (field.kind === "number") {
        payload[field.column] = Number(value);
      } else {
        payload[field.column] = value;
      }
    });
    return payload;
  }

  // Migration 0005 names each check profiles_<column>_<rule>, such as
  // profiles_full_name_length, so the name tells us which field to point at.
  function saveErrorMessage(error) {
    var message = (error && error.message) ? error.message : "unknown error";
    for (var i = 0; i < PROFILE_FIELDS.length; i++) {
      var field = PROFILE_FIELDS[i];
      if (message.indexOf("profiles_" + field.column + "_") !== -1) {
        return "Couldn't save: please check " + field.label + ".";
      }
    }
    return "Couldn't save: " + message;
  }

  profileFormEl.addEventListener("submit", function (event) {
    event.preventDefault();
    if (!currentUser) {
      showProfileError("You need to sign in again before saving.");
      return;
    }
    clearProfileError();
    var problem = firstProfileProblem();
    if (problem) {
      showProfileError(problem.message);
      problem.input.focus();
      return;
    }
    profileSaveButton.disabled = true;
    profileStatusEl.textContent = "Saving...";
    client.from("profiles")
      .upsert(profilePayload(currentUser.id), { onConflict: "user_id" })
      .select(PROFILE_SELECT)
      .single()
      .then(function (res) {
        profileSaveButton.disabled = false;
        if (res.error) {
          // The form keeps the member's input so they can correct it.
          showProfileError(saveErrorMessage(res.error));
          return;
        }
        profileStatusEl.textContent = "Saved.";
        fillProfileForm(res.data);
      });
  });

  // The link is a convenience only: organize.html and the organizer functions
  // check the grant again on the server.
  function checkOrganizer(userId) {
    client.rpc("has_club_role", { required_role: "event_organizer" }).then(function (res) {
      if (!stillShowing(userId)) return;
      organizerEl.hidden = res.data !== true;
    });
  }

  // ------------------------------------------------------- achievements

  function clearAchievementsError() {
    achievementsErrorEl.textContent = "";
    achievementsErrorEl.hidden = true;
  }

  function showAchievementsError(message) {
    achievementsErrorEl.textContent = message;
    achievementsErrorEl.hidden = false;
  }

  function loadAchievements(userId) {
    clearAchievementsError();
    clearChildren(achievementsListEl);
    achievementsEmptyEl.hidden = true;
    client.from("achievement_awards")
      .select(ACHIEVEMENT_SELECT)
      .is("invalidated_at", null)
      .then(function (res) {
        if (!stillShowing(userId)) return;
        if (res.error) {
          showAchievementsError("Couldn't load your achievements. Please try again later.");
          return;
        }
        showAchievements(res.data || []);
      });
  }

  function definitionOrder(definition) {
    var order = Number(definition.display_order);
    return Number.isFinite(order) ? order : 0;
  }

  function formatEarnedDate(value) {
    var date = new Date(value);
    if (Number.isNaN(date.getTime())) {
      // An unreadable timestamp still says when the award was granted.
      return value === null || value === undefined ? "" : String(value);
    }
    return date.toLocaleDateString("en-GB", { day: "numeric", month: "long", year: "numeric" });
  }

  function textBlock(tag, text, className) {
    var el = document.createElement(tag);
    el.textContent = text;
    if (className) el.className = className;
    return el;
  }

  function achievementItem(definition, grantedAt) {
    var item = document.createElement("li");
    item.appendChild(textBlock("strong", definition.label || "Achievement"));
    if (definition.description) item.appendChild(textBlock("div", definition.description));
    item.appendChild(textBlock("div", "Earned " + formatEarnedDate(grantedAt), "note"));
    return item;
  }

  function showAchievements(rows) {
    var awards = [];
    rows.forEach(function (row) {
      // A row whose definition is not visible is not something to show.
      if (!row.achievement_definitions) return;
      awards.push({ definition: row.achievement_definitions, grantedAt: row.granted_at });
    });
    awards.sort(function (a, b) {
      return definitionOrder(a.definition) - definitionOrder(b.definition);
    });
    awards.forEach(function (award) {
      achievementsListEl.appendChild(achievementItem(award.definition, award.grantedAt));
    });
    achievementsEmptyEl.hidden = awards.length > 0;
  }

  // ------------------------------------------------------------- wiring

  client.auth.getSession().then(function (res) {
    render(res.data.session);
    returnToSavedContext(res.data.session);
  });
  client.auth.onAuthStateChange(function (event, session) {
    render(session);
    if (event === "SIGNED_IN" || event === "INITIAL_SESSION") returnToSavedContext(session);
  });

  sendButton.addEventListener("click", function () {
    var email = emailEl.value.trim();
    if (!email) { showError("enter an email address first"); return; }
    if (captchaRequired && !captchaToken) { showError("complete the security check first"); return; }
    var authOptions = { emailRedirectTo: accountUrl.href };
    if (captchaRequired) authOptions.captchaToken = captchaToken;
    client.auth.signInWithOtp({
      email: email,
      options: authOptions
    }).then(function (res) {
      if (captchaRequired && window.turnstile) window.turnstile.reset();
      captchaToken = null;
      if (res.error) {
        showError(res.error.message);
      } else {
        formEl.hidden = true;
        sentEl.hidden = false;
        sentEmailEl.textContent = email;
      }
    });
  });

  signOutButton.addEventListener("click", function () {
    client.auth.signOut().then(function (res) {
      if (res.error) showError(res.error.message);
    });
  });
})();
