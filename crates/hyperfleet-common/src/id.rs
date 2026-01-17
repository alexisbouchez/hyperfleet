// Copyright (c) 2025 Alexis Bouchez <alexbcz@proton.me>
// Licensed under the AGPL-3.0 License. See LICENSE file for details.

//! ID generation utilities.

use nanoid::nanoid;

/// Alphabet for machine IDs (lowercase alphanumeric only).
const ALPHABET: [char; 36] = [
    'a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i', 'j', 'k', 'l', 'm', 'n', 'o', 'p', 'q', 'r', 's',
    't', 'u', 'v', 'w', 'x', 'y', 'z', '0', '1', '2', '3', '4', '5', '6', '7', '8', '9',
];

/// Length of machine IDs.
const ID_LENGTH: usize = 8;

/// Generate a new machine ID.
///
/// Returns an 8-character NanoID using lowercase alphanumeric characters.
/// This format is subdomain-safe, URL-safe, and human-typeable.
pub fn generate_id() -> String {
    nanoid!(ID_LENGTH, &ALPHABET)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_generate_id_length() {
        let id = generate_id();
        assert_eq!(id.len(), 8);
    }

    #[test]
    fn test_generate_id_alphabet() {
        let id = generate_id();
        for c in id.chars() {
            assert!(c.is_ascii_lowercase() || c.is_ascii_digit());
        }
    }

    #[test]
    fn test_generate_id_uniqueness() {
        let id1 = generate_id();
        let id2 = generate_id();
        assert_ne!(id1, id2);
    }
}
