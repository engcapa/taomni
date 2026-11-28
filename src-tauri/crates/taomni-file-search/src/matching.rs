use crate::SearchEntry;
use std::collections::BTreeMap;
use std::path::Path;

pub(super) const RESULT_LIMIT: usize = 100;

pub(super) struct Matches {
    query: String,
    ranked: BTreeMap<(u8, usize, usize, String), SearchEntry>,
    pub clipped: bool,
}

impl Matches {
    pub fn new(query: &str) -> Self {
        Self {
            query: query.to_lowercase(),
            ranked: BTreeMap::new(),
            clipped: false,
        }
    }

    pub fn rank(&self, name: &str) -> Option<(u8, usize, usize)> {
        let name = name.to_lowercase();
        let length = name.len();
        if name == self.query {
            return Some((0, 0, length));
        }
        if let Some(index) = name.find(&self.query) {
            return Some((if index == 0 { 1 } else { 2 }, index, length));
        }
        let mut chars = name.char_indices();
        let mut first = None;
        let mut last = 0;
        for needle in self.query.chars() {
            let (index, c) = chars.find(|(_, c)| *c == needle)?;
            first.get_or_insert(index);
            last = index + c.len_utf8();
        }
        Some((3, last - first?, length))
    }

    pub fn insert(&mut self, path: &Path, name: &str, directory: bool, rank: (u8, usize, usize)) {
        let Some(path) = path.to_str() else { return };
        let key = (rank.0, rank.1, rank.2, path.to_owned());
        if self.ranked.len() == RESULT_LIMIT
            && self
                .ranked
                .last_key_value()
                .is_some_and(|(worst, _)| key > *worst)
        {
            self.clipped = true;
            return;
        }
        self.ranked.insert(
            key,
            SearchEntry {
                path: path.to_owned(),
                name: name.to_owned(),
                is_directory: directory,
            },
        );
        if self.ranked.len() > RESULT_LIMIT {
            self.ranked.pop_last();
            self.clipped = true;
        }
    }

    pub fn entries(self) -> Vec<SearchEntry> {
        self.ranked.into_values().collect()
    }
}
