//! Souls the user can bind to a Space or call on by name.

use serde::{Deserialize, Serialize};

/// One soul, as `soul.list` reports it.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct SoulSummary {
    /// Directory name: the stable key used for bindings and on the wire.
    pub slug: String,
    /// The name users see and type after `@`.
    pub name: String,
    /// One line about what this assistant is for.
    #[serde(default)]
    pub description: String,
    /// Inlined avatar, when the soul has one.
    #[serde(default)]
    pub avatar: Option<String>,
}

/// The soul answering right now.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ActiveSoul {
    pub slug: String,
    pub name: String,
    pub avatar: Option<String>,
    /// True when the user picked this soul for now, rather than it being the one
    /// this Space always uses. The composer shows the two differently: a pick is
    /// something you can undo, a Space's own soul is not.
    pub is_override: bool,
}

/// Find a soul by the name a user typed after `@`.
///
/// Case-insensitive, because `@Alex` is plainly the same request as `@alex`.
/// Falls back to matching the slug so a soul stays reachable by its folder name.
pub fn find_soul_by_mention<'a>(souls: &'a [SoulSummary], typed: &str) -> Option<&'a SoulSummary> {
    let typed = typed.trim();
    souls
        .iter()
        .find(|s| s.name.eq_ignore_ascii_case(typed))
        .or_else(|| souls.iter().find(|s| s.slug.eq_ignore_ascii_case(typed)))
}

/// The souls whose name starts with what the user has typed so far.
///
/// An empty query lists everything, which is what a bare `@` should show.
pub fn filter_souls<'a>(souls: &'a [SoulSummary], query: &str) -> Vec<&'a SoulSummary> {
    let query = query.trim().to_ascii_lowercase();
    if query.is_empty() {
        return souls.iter().collect();
    }
    souls
        .iter()
        .filter(|s| {
            s.name.to_ascii_lowercase().starts_with(&query)
                || s.slug.to_ascii_lowercase().starts_with(&query)
        })
        .collect()
}

/// Work out which soul the composer should show.
///
/// Mirrors the daemon's own resolution so the chip tells the truth before the
/// next reply arrives: a soul the user picked wins over the one this Space uses,
/// and picking the Space's own soul is not an override at all — it is just the
/// Space's soul, so the chip must not offer to undo it.
///
/// `picked` is the slug the user chose this session, if any.
pub fn derive_active_soul(
    souls: &[SoulSummary],
    bindings: &std::collections::HashMap<String, String>,
    container: &str,
    picked: Option<&str>,
) -> Option<ActiveSoul> {
    let bound = bindings.get(container).map(|s| s.as_str());
    let slug = picked.or(bound)?;
    let soul = souls.iter().find(|s| s.slug == slug)?;

    Some(ActiveSoul {
        slug: soul.slug.clone(),
        name: soul.name.clone(),
        avatar: soul.avatar.clone(),
        is_override: picked.is_some() && picked != bound,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn bindings(pairs: &[(&str, &str)]) -> std::collections::HashMap<String, String> {
        pairs
            .iter()
            .map(|(k, v)| (k.to_string(), v.to_string()))
            .collect()
    }

    fn souls() -> Vec<SoulSummary> {
        vec![
            SoulSummary {
                slug: "research".into(),
                name: "alex".into(),
                description: "Research copilot".into(),
                avatar: None,
            },
            SoulSummary {
                slug: "engineer".into(),
                name: "nova".into(),
                description: "Frontend engineer".into(),
                avatar: None,
            },
        ]
    }

    #[test]
    fn a_mention_finds_its_soul_by_name() {
        let souls = souls();
        let found = find_soul_by_mention(&souls, "alex").unwrap();
        assert_eq!(found.slug, "research");
    }

    /// `@Alex` is the same request as `@alex`.
    #[test]
    fn mention_matching_ignores_case() {
        assert_eq!(
            find_soul_by_mention(&souls(), "ALEX").map(|s| s.slug.as_str()),
            Some("research")
        );
    }

    /// A soul stays reachable by its folder name, which is what the toml uses.
    #[test]
    fn a_mention_can_name_the_slug() {
        assert_eq!(
            find_soul_by_mention(&souls(), "engineer").map(|s| s.slug.as_str()),
            Some("engineer")
        );
    }

    /// A name nobody has is just text, not an error.
    #[test]
    fn an_unknown_mention_finds_nothing() {
        assert!(find_soul_by_mention(&souls(), "nobody").is_none());
        assert!(find_soul_by_mention(&souls(), "").is_none());
    }

    #[test]
    fn a_bare_at_offers_every_soul() {
        assert_eq!(filter_souls(&souls(), "").len(), 2);
    }

    #[test]
    fn typing_narrows_the_list() {
        let souls = souls();
        let filtered = filter_souls(&souls, "al");
        assert_eq!(filtered.len(), 1);
        assert_eq!(filtered[0].name, "alex");

        assert!(filter_souls(&souls, "zz").is_empty());
    }

    #[test]
    fn filtering_ignores_case_and_matches_slugs_too() {
        assert_eq!(filter_souls(&souls(), "AL").len(), 1);
        assert_eq!(filter_souls(&souls(), "resea").len(), 1);
    }

    /// The wire shape `soul.list` sends must parse as-is.
    #[test]
    fn a_soul_summary_parses_from_the_daemon() {
        let json = serde_json::json!({
            "slug": "research",
            "name": "alex",
            "description": "Research copilot",
            "avatar": "data:image/png;base64,AAAA"
        });
        let soul: SoulSummary = serde_json::from_value(json).unwrap();
        assert_eq!(soul.slug, "research");
        assert_eq!(soul.avatar.as_deref(), Some("data:image/png;base64,AAAA"));
    }

    /// A soul with no avatar and no description is still a soul.
    #[test]
    fn a_soul_summary_tolerates_missing_optionals() {
        let json = serde_json::json!({ "slug": "plain", "name": "plain" });
        let soul: SoulSummary = serde_json::from_value(json).unwrap();
        assert!(soul.avatar.is_none());
        assert!(soul.description.is_empty());
    }

    // ── derive_active_soul ─────────────────────────────────────────────

    /// A Space with no soul of its own gets the default assistant, and the chip
    /// has nothing to show.
    #[test]
    fn an_unbound_container_has_no_active_soul() {
        assert!(derive_active_soul(&souls(), &bindings(&[]), "firefox-default", None).is_none());
    }

    /// The Space's own soul is not an override: there is nothing to undo.
    #[test]
    fn a_bound_container_shows_its_own_soul() {
        let active = derive_active_soul(
            &souls(),
            &bindings(&[("firefox-container-1", "research")]),
            "firefox-container-1",
            None,
        )
        .unwrap();

        assert_eq!(active.name, "alex");
        assert!(!active.is_override, "a Space's own soul is not an override");
    }

    /// Picking someone else is an override, and the chip offers to undo it.
    #[test]
    fn picking_another_soul_is_an_override() {
        let active = derive_active_soul(
            &souls(),
            &bindings(&[("firefox-container-1", "research")]),
            "firefox-container-1",
            Some("engineer"),
        )
        .unwrap();

        assert_eq!(active.name, "nova");
        assert!(active.is_override);
    }

    /// Picking the soul this Space already uses is not an override — otherwise the
    /// chip would offer to undo something that was never done.
    #[test]
    fn picking_the_spaces_own_soul_is_not_an_override() {
        let active = derive_active_soul(
            &souls(),
            &bindings(&[("firefox-container-1", "research")]),
            "firefox-container-1",
            Some("research"),
        )
        .unwrap();

        assert!(!active.is_override);
    }

    /// A pick still shows in a Space that has no soul of its own.
    #[test]
    fn picking_in_an_unbound_container_is_an_override() {
        let active = derive_active_soul(
            &souls(),
            &bindings(&[]),
            "firefox-default",
            Some("research"),
        )
        .unwrap();

        assert!(active.is_override);
    }

    /// A binding left pointing at a deleted soul shows nothing rather than a
    /// broken chip — the same fallback the daemon makes.
    #[test]
    fn a_binding_to_a_missing_soul_shows_nothing() {
        assert!(derive_active_soul(
            &souls(),
            &bindings(&[("firefox-container-1", "deleted")]),
            "firefox-container-1",
            None,
        )
        .is_none());
    }
}
