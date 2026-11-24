use std::collections::HashSet;
use std::time::Duration;

use serde::{Deserialize, Serialize};

use crate::database::MediaType;
use crate::settings::AppSettings;
use crate::tmdb::{search_tmdb, ScrapeCandidate};

const REQUEST_TIMEOUT_SECONDS: u64 = 10;
const RESULT_LIMIT: usize = 12;
const BANGUMI_USER_AGENT: &str = "CatchUp/0.1 (Tauri app; +https://github.com/catch-up)";
const BANGUMI_SEARCH_URL: &str = "https://api.bgm.tv/v0/search/subjects?limit=10";
const ANILIST_ENDPOINT: &str = "https://graphql.anilist.co";
const TVMAZE_SEARCH_URL: &str = "https://api.tvmaze.com/search/shows";
const OPEN_LIBRARY_SEARCH_URL: &str = "https://openlibrary.org/search.json";
const OVERVIEW_LIMIT: usize = 800;

const ANILIST_QUERY: &str = r#"
query ($search: String, $type: MediaType) {
  Page(perPage: 10) {
    media(search: $search, type: $type, sort: SEARCH_MATCH) {
      id
      title { romaji native english }
      startDate { year }
      coverImage { large }
      averageScore
      description(asHtml: false)
      episodes
      chapters
    }
  }
}
"#;

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SmartScrapeResult {
    pub candidates: Vec<ScrapeCandidate>,
    pub confident: bool,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Provider {
    Bangumi(u8),
    AniList(&'static str),
    Tvmaze,
    OpenLibrary,
    Tmdb(MediaType),
}

impl Provider {
    fn kind(self) -> &'static str {
        match self {
            Self::Bangumi(2) | Self::AniList("ANIME") => "anime",
            Self::Bangumi(1) | Self::AniList("MANGA") | Self::OpenLibrary => "novel",
            Self::Tmdb(MediaType::Movie) => "movie",
            _ => "tv",
        }
    }
}

fn providers_for(media_type: Option<MediaType>) -> Vec<Provider> {
    match media_type {
        Some(MediaType::Anime) => vec![Provider::Bangumi(2), Provider::AniList("ANIME")],
        Some(MediaType::Novel) => vec![
            Provider::Bangumi(1),
            Provider::AniList("MANGA"),
            Provider::OpenLibrary,
        ],
        Some(MediaType::Movie) => vec![Provider::Tmdb(MediaType::Movie)],
        other => vec![
            Provider::Tmdb(other.unwrap_or(MediaType::Drama)),
            Provider::Tvmaze,
            Provider::Bangumi(6),
        ],
    }
}

/// 多源聚合搜索：按内容类型并发度不同的数据源，统一打分后返回候选。
pub async fn smart_scrape(
    settings: &AppSettings,
    query: &str,
    media_type: Option<MediaType>,
) -> Result<SmartScrapeResult, String> {
    let query = query.trim();
    if query.is_empty() {
        return Err("请输入要搜索的标题".to_owned());
    }

    let has_tmdb_key = !settings.tmdb_api_key.trim().is_empty();
    let providers = providers_for(media_type);
    if media_type == Some(MediaType::Movie) && !has_tmdb_key {
        return Err("电影目前只有 TMDB 数据源，请先在设置中填写 TMDB API Key".to_owned());
    }

    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(REQUEST_TIMEOUT_SECONDS))
        .build()
        .map_err(|error| format!("无法初始化网络请求：{error}"))?;

    let mut candidates = Vec::new();
    let mut errors = Vec::new();
    let mut attempted = 0usize;

    for provider in providers {
        if matches!(provider, Provider::Tmdb(_)) && !has_tmdb_key {
            continue;
        }
        attempted += 1;
        match fetch(&client, provider, settings, query).await {
            Ok(mut items) => candidates.append(&mut items),
            Err(error) => errors.push(error),
        }
    }

    if attempted == 0 {
        return Err("当前内容类型没有可用的数据源。".to_owned());
    }
    if candidates.is_empty() && !errors.is_empty() {
        return Err(errors.join("\n"));
    }

    let key = normalize_key(query);
    let candidates = rank(candidates, &key);
    let confident = candidates
        .first()
        .is_some_and(|candidate| matches_exactly(candidate, &key));
    Ok(SmartScrapeResult {
        candidates,
        confident,
    })
}

async fn fetch(
    client: &reqwest::Client,
    provider: Provider,
    settings: &AppSettings,
    query: &str,
) -> Result<Vec<ScrapeCandidate>, String> {
    match provider {
        Provider::Bangumi(subject_type) => {
            fetch_bangumi(client, query, subject_type, provider.kind()).await
        }
        Provider::AniList(media) => fetch_anilist(client, query, media, provider.kind()).await,
        Provider::Tvmaze => fetch_tvmaze(client, query).await,
        Provider::OpenLibrary => fetch_open_library(client, query).await,
        Provider::Tmdb(media_type) => search_tmdb(settings, query, Some(media_type)).await,
    }
}

#[derive(Debug, Default, Deserialize)]
struct BangumiResponse {
    #[serde(default)]
    data: Option<Vec<BangumiSubject>>,
}

#[derive(Debug, Default, Deserialize)]
struct BangumiSubject {
    #[serde(default)]
    id: u32,
    #[serde(default)]
    name: Option<String>,
    #[serde(default)]
    name_cn: Option<String>,
    #[serde(default)]
    summary: Option<String>,
    #[serde(default)]
    date: Option<String>,
    #[serde(default)]
    images: Option<BangumiImages>,
    #[serde(default)]
    rating: Option<BangumiRating>,
    #[serde(default)]
    eps: Option<u32>,
    #[serde(default)]
    volumes: Option<u32>,
}

#[derive(Debug, Default, Deserialize)]
struct BangumiImages {
    #[serde(default)]
    large: Option<String>,
}

#[derive(Debug, Default, Deserialize)]
struct BangumiRating {
    #[serde(default)]
    score: Option<f64>,
}

async fn fetch_bangumi(
    client: &reqwest::Client,
    query: &str,
    subject_type: u8,
    kind: &str,
) -> Result<Vec<ScrapeCandidate>, String> {
    let body = serde_json::json!({
        "keyword": query,
        "filter": { "type": [subject_type] },
    });
    let response = client
        .post(BANGUMI_SEARCH_URL)
        .header(reqwest::header::USER_AGENT, BANGUMI_USER_AGENT)
        .json(&body)
        .send()
        .await
        .map_err(|error| describe_request_error("Bangumi", &error))?;
    let status = response.status();
    if !status.is_success() {
        return Err(format!("Bangumi 搜索失败（HTTP {status}）"));
    }
    let body = response
        .text()
        .await
        .map_err(|error| describe_request_error("Bangumi", &error))?;
    map_bangumi_response(&body, kind)
}

fn map_bangumi_response(body: &str, kind: &str) -> Result<Vec<ScrapeCandidate>, String> {
    let response: BangumiResponse =
        serde_json::from_str(body).map_err(|error| format!("解析 Bangumi 返回内容失败：{error}"))?;
    Ok(response
        .data
        .unwrap_or_default()
        .into_iter()
        .filter_map(|subject| {
            let original_title = non_empty(subject.name);
            let title = non_empty(subject.name_cn).or_else(|| original_title.clone())?;
            Some(ScrapeCandidate {
                source_id: subject.id,
                title,
                original_title,
                year: subject.date.as_deref().and_then(year_from_date),
                poster_url: subject.images.and_then(|images| non_empty(images.large)),
                rating: subject
                    .rating
                    .and_then(|rating| rating.score)
                    .filter(|score| *score > 0.0)
                    .map(round_rating),
                overview: clean_overview(subject.summary),
                kind: kind.to_owned(),
                source: Some("Bangumi".to_owned()),
                total_episodes: subject
                    .eps
                    .or(subject.volumes)
                    .filter(|count| *count > 0),
            })
        })
        .collect())
}

#[derive(Debug, Default, Deserialize)]
struct AniListResponse {
    #[serde(default)]
    data: Option<AniListData>,
}

#[derive(Debug, Default, Deserialize)]
struct AniListData {
    #[serde(default)]
    page: Option<AniListPage>,
}

#[derive(Debug, Default, Deserialize)]
struct AniListPage {
    #[serde(default)]
    media: Option<Vec<AniListMedia>>,
}

#[derive(Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
struct AniListMedia {
    #[serde(default)]
    id: u32,
    #[serde(default)]
    title: Option<AniListTitle>,
    #[serde(default)]
    start_date: Option<AniListDate>,
    #[serde(default)]
    cover_image: Option<AniListCover>,
    #[serde(default)]
    average_score: Option<u32>,
    #[serde(default)]
    description: Option<String>,
    #[serde(default)]
    episodes: Option<u32>,
    #[serde(default)]
    chapters: Option<u32>,
}

#[derive(Debug, Default, Deserialize)]
struct AniListTitle {
    #[serde(default)]
    romaji: Option<String>,
    #[serde(default)]
    native: Option<String>,
    #[serde(default)]
    english: Option<String>,
}

#[derive(Debug, Default, Deserialize)]
struct AniListDate {
    #[serde(default)]
    year: Option<u32>,
}

#[derive(Debug, Default, Deserialize)]
struct AniListCover {
    #[serde(default)]
    large: Option<String>,
}

async fn fetch_anilist(
    client: &reqwest::Client,
    query: &str,
    media: &str,
    kind: &str,
) -> Result<Vec<ScrapeCandidate>, String> {
    let body = serde_json::json!({
        "query": ANILIST_QUERY,
        "variables": { "search": query, "type": media },
    });
    let response = client
        .post(ANILIST_ENDPOINT)
        .json(&body)
        .send()
        .await
        .map_err(|error| describe_request_error("AniList", &error))?;
    let status = response.status();
    if !status.is_success() {
        return Err(format!("AniList 搜索失败（HTTP {status}）"));
    }
    let body = response
        .text()
        .await
        .map_err(|error| describe_request_error("AniList", &error))?;
    map_anilist_response(&body, kind)
}

fn map_anilist_response(body: &str, kind: &str) -> Result<Vec<ScrapeCandidate>, String> {
    let response: AniListResponse =
        serde_json::from_str(body).map_err(|error| format!("解析 AniList 返回内容失败：{error}"))?;
    let media = response
        .data
        .and_then(|data| data.page)
        .and_then(|page| page.media)
        .unwrap_or_default();
    Ok(media
        .into_iter()
        .filter_map(|item| {
            let titles = item.title.unwrap_or_default();
            let native = non_empty(titles.native);
            let romaji = non_empty(titles.romaji);
            let english = non_empty(titles.english);
            let title = english
                .clone()
                .or_else(|| romaji.clone())
                .or_else(|| native.clone())?;
            Some(ScrapeCandidate {
                source_id: item.id,
                title,
                original_title: romaji.or(native),
                year: item.start_date.and_then(|date| date.year),
                poster_url: item.cover_image.and_then(|cover| non_empty(cover.large)),
                rating: item
                    .average_score
                    .filter(|score| *score > 0)
                    .map(|score| round_rating(f64::from(score) / 10.0)),
                overview: clean_overview(item.description),
                kind: kind.to_owned(),
                source: Some("AniList".to_owned()),
                total_episodes: item.episodes.or(item.chapters).filter(|count| *count > 0),
            })
        })
        .collect())
}

#[derive(Debug, Default, Deserialize)]
struct TvmazeResult {
    #[serde(default)]
    show: Option<TvmazeShow>,
}

#[derive(Debug, Default, Deserialize)]
struct TvmazeShow {
    #[serde(default)]
    id: u32,
    #[serde(default)]
    name: Option<String>,
    #[serde(default)]
    premiered: Option<String>,
    #[serde(default)]
    image: Option<TvmazeImage>,
    #[serde(default)]
    rating: Option<TvmazeRating>,
    #[serde(default)]
    summary: Option<String>,
}

#[derive(Debug, Default, Deserialize)]
struct TvmazeImage {
    #[serde(default)]
    medium: Option<String>,
    #[serde(default)]
    original: Option<String>,
}

#[derive(Debug, Default, Deserialize)]
struct TvmazeRating {
    #[serde(default)]
    average: Option<f64>,
}

async fn fetch_tvmaze(
    client: &reqwest::Client,
    query: &str,
) -> Result<Vec<ScrapeCandidate>, String> {
    let response = client
        .get(TVMAZE_SEARCH_URL)
        .query(&[("q", query)])
        .send()
        .await
        .map_err(|error| describe_request_error("TVMaze", &error))?;
    let status = response.status();
    if !status.is_success() {
        return Err(format!("TVMaze 搜索失败（HTTP {status}）"));
    }
    let body = response
        .text()
        .await
        .map_err(|error| describe_request_error("TVMaze", &error))?;
    map_tvmaze_response(&body)
}

fn map_tvmaze_response(body: &str) -> Result<Vec<ScrapeCandidate>, String> {
    let results: Vec<TvmazeResult> =
        serde_json::from_str(body).map_err(|error| format!("解析 TVMaze 返回内容失败：{error}"))?;
    Ok(results
        .into_iter()
        .filter_map(|result| result.show)
        .filter_map(|show| {
            let title = non_empty(show.name)?;
            Some(ScrapeCandidate {
                source_id: show.id,
                title,
                original_title: None,
                year: show.premiered.as_deref().and_then(year_from_date),
                poster_url: show
                    .image
                    .and_then(|image| non_empty(image.original).or_else(|| non_empty(image.medium))),
                rating: show
                    .rating
                    .and_then(|rating| rating.average)
                    .filter(|average| *average > 0.0)
                    .map(round_rating),
                overview: clean_overview(show.summary),
                kind: "tv".to_owned(),
                source: Some("TVMaze".to_owned()),
                total_episodes: None,
            })
        })
        .collect())
}

#[derive(Debug, Default, Deserialize)]
struct OpenLibraryResponse {
    #[serde(default)]
    docs: Option<Vec<OpenLibraryDoc>>,
}

#[derive(Debug, Default, Deserialize)]
struct OpenLibraryDoc {
    #[serde(default)]
    key: Option<String>,
    #[serde(default)]
    title: Option<String>,
    #[serde(default)]
    author_name: Option<Vec<String>>,
    #[serde(default)]
    first_publish_year: Option<u32>,
    #[serde(default)]
    cover_i: Option<i64>,
    #[serde(default)]
    ratings_average: Option<f64>,
}

async fn fetch_open_library(
    client: &reqwest::Client,
    query: &str,
) -> Result<Vec<ScrapeCandidate>, String> {
    let response = client
        .get(OPEN_LIBRARY_SEARCH_URL)
        .query(&[
            ("q", query),
            ("limit", "10"),
            (
                "fields",
                "key,title,author_name,first_publish_year,cover_i,ratings_average",
            ),
        ])
        .send()
        .await
        .map_err(|error| describe_request_error("Open Library", &error))?;
    let status = response.status();
    if !status.is_success() {
        return Err(format!("Open Library 搜索失败（HTTP {status}）"));
    }
    let body = response
        .text()
        .await
        .map_err(|error| describe_request_error("Open Library", &error))?;
    map_open_library_response(&body)
}

fn map_open_library_response(body: &str) -> Result<Vec<ScrapeCandidate>, String> {
    let response: OpenLibraryResponse = serde_json::from_str(body)
        .map_err(|error| format!("解析 Open Library 返回内容失败：{error}"))?;
    Ok(response
        .docs
        .unwrap_or_default()
        .into_iter()
        .filter_map(|doc| {
            let title = non_empty(doc.title)?;
            let author = doc
                .author_name
                .unwrap_or_default()
                .into_iter()
                .map(|name| name.trim().to_owned())
                .filter(|name| !name.is_empty())
                .collect::<Vec<_>>();
            let overview = (!author.is_empty()).then(|| format!("作者：{}", author.join("、")));
            Some(ScrapeCandidate {
                source_id: doc
                    .key
                    .as_deref()
                    .map(stable_id)
                    .or_else(|| doc.cover_i.map(|cover| cover as u32))
                    .unwrap_or(0),
                title,
                original_title: None,
                year: doc.first_publish_year,
                poster_url: doc
                    .cover_i
                    .map(|cover| format!("https://covers.openlibrary.org/b/id/{cover}-L.jpg")),
                rating: doc
                    .ratings_average
                    .filter(|average| *average > 0.0)
                    .map(|average| round_rating(average * 2.0)),
                overview,
                kind: "novel".to_owned(),
                source: Some("Open Library".to_owned()),
                total_episodes: None,
            })
        })
        .collect())
}

fn rank(candidates: Vec<ScrapeCandidate>, key: &str) -> Vec<ScrapeCandidate> {
    let mut scored = candidates
        .into_iter()
        .map(|candidate| {
            let (exact, similarity) = match_score(&candidate, key);
            let mut score = similarity + source_priority(candidate.source.as_deref());
            if candidate.poster_url.is_some() {
                score += 10;
            }
            if candidate.overview.is_some() {
                score += 5;
            }
            if candidate.rating.is_some() {
                score += 3;
            }
            if candidate.year.is_some() {
                score += 2;
            }
            if candidate.total_episodes.is_some() {
                score += 3;
            }
            (exact, score, candidate)
        })
        .collect::<Vec<_>>();

    scored.sort_by(|left, right| {
        right
            .0
            .cmp(&left.0)
            .then_with(|| right.1.cmp(&left.1))
            .then_with(|| left.2.title.cmp(&right.2.title))
    });

    let mut seen = HashSet::new();
    let mut result = Vec::new();
    for (_, _, candidate) in scored {
        let dedupe_key = format!(
            "{}|{}",
            normalize_key(&candidate.title),
            candidate.year.unwrap_or_default()
        );
        if seen.insert(dedupe_key) {
            result.push(candidate);
            if result.len() >= RESULT_LIMIT {
                break;
            }
        }
    }
    result
}

fn match_score(candidate: &ScrapeCandidate, key: &str) -> (bool, i32) {
    if key.is_empty() {
        return (false, 20);
    }
    let mut best = 20;
    for title in [Some(candidate.title.as_str()), candidate.original_title.as_deref()]
        .into_iter()
        .flatten()
    {
        let normalized = normalize_key(title);
        if normalized.is_empty() {
            continue;
        }
        if normalized == key {
            return (true, 100);
        }
        if normalized.contains(key) || key.contains(&normalized) {
            best = best.max(55);
        }
    }
    (false, best)
}

fn matches_exactly(candidate: &ScrapeCandidate, key: &str) -> bool {
    !key.is_empty()
        && [Some(candidate.title.as_str()), candidate.original_title.as_deref()]
            .into_iter()
            .flatten()
            .any(|title| normalize_key(title) == key)
}

fn source_priority(source: Option<&str>) -> i32 {
    match source {
        Some("TMDB") | Some("Bangumi") => 6,
        Some("AniList") => 4,
        Some("TVMaze") => 3,
        Some("Open Library") => 2,
        _ => 0,
    }
}

fn normalize_key(raw: &str) -> String {
    raw.chars()
        .filter_map(|ch| {
            let ch = if ('\u{FF01}'..='\u{FF5E}').contains(&ch) {
                char::from_u32(ch as u32 - 0xFEE0).unwrap_or(ch)
            } else if ch == '\u{3000}' {
                ' '
            } else {
                ch
            };
            if ch.is_whitespace() || ch.is_ascii_punctuation() {
                return None;
            }
            if matches!(
                ch,
                '，' | '。'
                    | '、'
                    | '；'
                    | '：'
                    | '！'
                    | '？'
                    | '“'
                    | '”'
                    | '‘'
                    | '’'
                    | '（'
                    | '）'
                    | '【'
                    | '】'
                    | '《'
                    | '》'
                    | '「'
                    | '」'
                    | '『'
                    | '』'
                    | '·'
                    | '・'
                    | '—'
                    | '–'
                    | '…'
                    | '～'
                    | '〈'
                    | '〉'
            ) {
                return None;
            }
            Some(ch.to_ascii_lowercase())
        })
        .collect()
}

fn non_empty(value: Option<String>) -> Option<String> {
    value
        .map(|text| text.trim().to_owned())
        .filter(|text| !text.is_empty())
}

fn year_from_date(value: &str) -> Option<u32> {
    let year = value.get(0..4)?;
    let parsed = year.parse::<u32>().ok()?;
    (parsed > 0).then_some(parsed)
}

fn round_rating(value: f64) -> f64 {
    (value * 10.0).round() / 10.0
}

fn clean_overview(value: Option<String>) -> Option<String> {
    let text = non_empty(value)?;
    let text = strip_html(&text);
    if text.is_empty() {
        return None;
    }
    let truncated = if text.chars().count() > OVERVIEW_LIMIT {
        let mut shortened = text.chars().take(OVERVIEW_LIMIT).collect::<String>();
        shortened.push('…');
        shortened
    } else {
        text
    };
    Some(truncated)
}

fn strip_html(input: &str) -> String {
    let mut output = String::with_capacity(input.len());
    let mut in_tag = false;
    for ch in input.chars() {
        match ch {
            '<' => in_tag = true,
            '>' => {
                in_tag = false;
                output.push(' ');
            }
            _ if !in_tag => output.push(ch),
            _ => {}
        }
    }
    let decoded = output
        .replace("&amp;", "&")
        .replace("&lt;", "<")
        .replace("&gt;", ">")
        .replace("&quot;", "\"")
        .replace("&#39;", "'")
        .replace("&nbsp;", " ");
    decoded.split_whitespace().collect::<Vec<_>>().join(" ")
}

fn stable_id(text: &str) -> u32 {
    let mut hash: u32 = 0x811c9dc5;
    for byte in text.as_bytes() {
        hash ^= u32::from(*byte);
        hash = hash.wrapping_mul(0x01000193);
    }
    hash
}

fn describe_request_error(provider: &str, error: &reqwest::Error) -> String {
    if error.is_timeout() {
        return format!("{provider} 请求超时（{REQUEST_TIMEOUT_SECONDS} 秒），请稍后重试。");
    }
    if error.is_connect() {
        return format!("无法连接 {provider}，请检查网络后重试。");
    }
    format!("请求 {provider} 失败：{error}")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn providers_follow_media_type() {
        assert_eq!(
            providers_for(Some(MediaType::Anime)),
            vec![Provider::Bangumi(2), Provider::AniList("ANIME")]
        );
        assert_eq!(
            providers_for(Some(MediaType::Novel)),
            vec![
                Provider::Bangumi(1),
                Provider::AniList("MANGA"),
                Provider::OpenLibrary
            ]
        );
        assert_eq!(
            providers_for(Some(MediaType::Movie)),
            vec![Provider::Tmdb(MediaType::Movie)]
        );
        assert_eq!(providers_for(None).len(), 3);
    }

    #[test]
    fn title_normalization_ignores_case_width_and_punctuation() {
        assert_eq!(normalize_key("  Ｄｕｎｅ：Part Two "), "duneparttwo");
        assert_eq!(normalize_key("庆余年·第二季"), "庆余年第二季");
        assert_eq!(normalize_key("《漫长的季节》"), "漫长的季节");
    }

    #[test]
    fn bangumi_response_maps_fields() {
        let body = serde_json::json!({
            "data": [
                {
                    "id": 302267,
                    "name": "Sousou no Frieren",
                    "name_cn": "葬送的芙莉莲",
                    "summary": "勇者一行击败魔王后的故事。",
                    "date": "2023-09-29",
                    "images": { "large": "https://lain.bgm.tv/pic/cover/l/frieren.jpg" },
                    "rating": { "score": 8.85 },
                    "eps": 28
                },
                {
                    "id": 1,
                    "name": "Only Original",
                    "name_cn": "",
                    "date": "",
                    "rating": { "score": 0 }
                }
            ]
        })
        .to_string();

        let candidates = map_bangumi_response(&body, "anime").unwrap();
        assert_eq!(candidates.len(), 2);
        let first = &candidates[0];
        assert_eq!(first.source_id, 302267);
        assert_eq!(first.title, "葬送的芙莉莲");
        assert_eq!(first.original_title.as_deref(), Some("Sousou no Frieren"));
        assert_eq!(first.year, Some(2023));
        assert_eq!(first.rating, Some(8.9));
        assert_eq!(first.total_episodes, Some(28));
        assert_eq!(first.source.as_deref(), Some("Bangumi"));
        assert_eq!(first.kind, "anime");
        let second = &candidates[1];
        assert_eq!(second.title, "Only Original");
        assert_eq!(second.rating, None);
        assert_eq!(second.year, None);
    }

    #[test]
    fn anilist_response_maps_html_description_and_scores() {
        let body = serde_json::json!({
            "data": {
                "page": {
                    "media": [
                        {
                            "id": 154587,
                            "title": {
                                "romaji": "Sousou no Frieren",
                                "native": "葬送のフリーレン",
                                "english": "Frieren: Beyond Journey's End"
                            },
                            "startDate": { "year": 2023 },
                            "coverImage": { "large": "https://s4.anilist.co/frieren.jpg" },
                            "averageScore": 91,
                            "description": "After the <i>party</i> defeats the Demon King.<br>New journey &amp; memories.",
                            "episodes": 28
                        }
                    ]
                }
            }
        })
        .to_string();

        let candidates = map_anilist_response(&body, "anime").unwrap();
        assert_eq!(candidates.len(), 1);
        let candidate = &candidates[0];
        assert_eq!(candidate.title, "Frieren: Beyond Journey's End");
        assert_eq!(
            candidate.original_title.as_deref(),
            Some("Sousou no Frieren")
        );
        assert_eq!(candidate.rating, Some(9.1));
        assert_eq!(
            candidate.overview.as_deref(),
            Some("After the party defeats the Demon King. New journey & memories.")
        );
        assert_eq!(candidate.total_episodes, Some(28));
        assert_eq!(candidate.source.as_deref(), Some("AniList"));
    }

    #[test]
    fn tvmaze_response_maps_show_and_sanitizes_html() {
        let body = serde_json::json!([
            {
                "score": 0.9,
                "show": {
                    "id": 4444,
                    "name": "The Long Season",
                    "premiered": "2023-04-22",
                    "image": { "medium": "https://static.tvmaze.com/m.jpg", "original": "https://static.tvmaze.com/o.jpg" },
                    "rating": { "average": 8.4 },
                    "summary": "<p>A <b>mystery</b> in a small town.</p>"
                }
            }
        ])
        .to_string();

        let candidates = map_tvmaze_response(&body).unwrap();
        assert_eq!(candidates.len(), 1);
        let candidate = &candidates[0];
        assert_eq!(candidate.title, "The Long Season");
        assert_eq!(candidate.year, Some(2023));
        assert_eq!(
            candidate.poster_url.as_deref(),
            Some("https://static.tvmaze.com/o.jpg")
        );
        assert_eq!(candidate.rating, Some(8.4));
        assert_eq!(candidate.overview.as_deref(), Some("A mystery in a small town."));
        assert_eq!(candidate.kind, "tv");
    }

    #[test]
    fn open_library_response_builds_cover_and_double_rating() {
        let body = serde_json::json!({
            "docs": [
                {
                    "key": "/works/OL123W",
                    "title": "The Three-Body Problem",
                    "author_name": ["Liu Cixin"],
                    "first_publish_year": 2008,
                    "cover_i": 8231856,
                    "ratings_average": 4.25
                }
            ]
        })
        .to_string();

        let candidates = map_open_library_response(&body).unwrap();
        assert_eq!(candidates.len(), 1);
        let candidate = &candidates[0];
        assert_eq!(candidate.title, "The Three-Body Problem");
        assert_eq!(candidate.year, Some(2008));
        assert_eq!(candidate.rating, Some(8.5));
        assert_eq!(
            candidate.poster_url.as_deref(),
            Some("https://covers.openlibrary.org/b/id/8231856-L.jpg")
        );
        assert_eq!(candidate.overview.as_deref(), Some("作者：Liu Cixin"));
        assert_eq!(candidate.kind, "novel");
    }

    fn candidate(title: &str, year: Option<u32>, source: &str) -> ScrapeCandidate {
        ScrapeCandidate {
            source_id: stable_id(title),
            title: title.to_owned(),
            original_title: None,
            year,
            poster_url: Some("https://example.com/poster.jpg".to_owned()),
            rating: Some(8.5),
            overview: Some("简介".to_owned()),
            kind: "anime".to_owned(),
            source: Some(source.to_owned()),
            total_episodes: Some(12),
        }
    }

    #[test]
    fn ranking_prefers_exact_match_and_dedupes_same_work() {
        let candidates = vec![
            candidate("葬送的芙莉莲 第二季", Some(2024), "Bangumi"),
            candidate("葬送的芙莉莲", Some(2023), "AniList"),
            candidate("葬送的芙莉莲", Some(2023), "Bangumi"),
        ];
        let ranked = rank(candidates, &normalize_key("葬送的芙莉莲"));
        assert_eq!(ranked.len(), 2);
        assert_eq!(ranked[0].title, "葬送的芙莉莲");
        assert_eq!(ranked[0].source.as_deref(), Some("Bangumi"));
        assert_eq!(ranked[1].year, Some(2024));
    }

    #[test]
    fn confidence_requires_exact_title_match() {
        let exact = vec![candidate("葬送的芙莉莲", Some(2023), "Bangumi")];
        assert!(matches_exactly(&exact[0], &normalize_key("葬送的芙莉莲")));

        let fuzzy = vec![candidate("葬送的芙莉莲 第二季", Some(2024), "Bangumi")];
        assert!(!matches_exactly(&fuzzy[0], &normalize_key("葬送的芙莉莲")));
    }
}
