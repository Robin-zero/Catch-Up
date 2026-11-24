use std::time::Duration;

use serde::{Deserialize, Serialize};

use crate::{database::MediaType, settings::AppSettings};

const TMDB_API_BASE: &str = "https://api.themoviedb.org/3";
const TMDB_SEARCH_LIMIT: usize = 10;
const TMDB_TIMEOUT_SECONDS: u64 = 15;

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ScrapeCandidate {
    pub source_id: u32,
    pub title: String,
    pub original_title: Option<String>,
    pub year: Option<u32>,
    pub poster_url: Option<String>,
    pub rating: Option<f64>,
    pub overview: Option<String>,
    pub kind: String,
    pub source: Option<String>,
    pub total_episodes: Option<u32>,
    pub platform: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SearchRequest {
    pub url: String,
    pub kind: &'static str,
}

/// 只依赖设置与用户输入构造请求，便于在没有网络时测试全部业务规则。
pub fn prepare_search(
    settings: &AppSettings,
    query: &str,
    media_type: Option<MediaType>,
) -> Result<SearchRequest, String> {
    let api_key = settings.tmdb_api_key.trim();
    if api_key.is_empty() {
        return Err("请先在设置中填写 TMDB API Key".to_owned());
    }

    let query = query.trim();
    if query.is_empty() {
        return Err("请输入要搜索的标题".to_owned());
    }

    let (path, kind) = match media_type {
        Some(MediaType::Movie) => ("movie", "movie"),
        Some(MediaType::Novel) => return Err("小说暂不支持 TMDB 刮削".to_owned()),
        _ => ("tv", "tv"),
    };

    let mut url = reqwest::Url::parse(&format!("{TMDB_API_BASE}/search/{path}"))
        .map_err(|error| format!("构造 TMDB 请求地址失败：{error}"))?;
    url.query_pairs_mut()
        .append_pair("api_key", api_key)
        .append_pair("language", "zh-CN")
        .append_pair("include_adult", "false")
        .append_pair("query", query);

    Ok(SearchRequest {
        url: url.into(),
        kind,
    })
}

#[derive(Debug, Default, Deserialize)]
struct TmdbSearchResponse {
    #[serde(default)]
    results: Vec<TmdbSearchResult>,
}

#[derive(Debug, Default, Deserialize)]
struct TmdbSearchResult {
    #[serde(default)]
    id: u32,
    #[serde(default)]
    title: Option<String>,
    #[serde(default)]
    name: Option<String>,
    #[serde(default)]
    original_title: Option<String>,
    #[serde(default)]
    original_name: Option<String>,
    #[serde(default)]
    release_date: Option<String>,
    #[serde(default)]
    first_air_date: Option<String>,
    #[serde(default)]
    poster_path: Option<String>,
    #[serde(default)]
    vote_average: Option<f64>,
    #[serde(default)]
    vote_count: Option<u32>,
    #[serde(default)]
    overview: Option<String>,
}

fn non_empty(value: Option<String>) -> Option<String> {
    value
        .map(|text| text.trim().to_owned())
        .filter(|text| !text.is_empty())
}

fn year_from_date(value: Option<String>) -> Option<u32> {
    let date = non_empty(value)?;
    let year = date.get(0..4)?;
    let parsed = year.parse::<u32>().ok()?;
    (parsed > 0).then_some(parsed)
}

fn poster_url_from_path(value: Option<String>) -> Option<String> {
    let path = non_empty(value)?;
    let path = if path.starts_with('/') {
        path
    } else {
        format!("/{path}")
    };
    Some(format!("https://image.tmdb.org/t/p/w500{path}"))
}

fn candidate_from_result(result: TmdbSearchResult, kind: &str) -> Option<ScrapeCandidate> {
    let original_title_value = non_empty(result.original_title);
    let original_name_value = non_empty(result.original_name);
    let title = non_empty(result.title)
        .or_else(|| non_empty(result.name))
        .or_else(|| original_title_value.clone())
        .or_else(|| original_name_value.clone())?;
    let original_title = original_title_value.or(original_name_value);
    let year = if kind == "movie" {
        year_from_date(result.release_date).or_else(|| year_from_date(result.first_air_date))
    } else {
        year_from_date(result.first_air_date).or_else(|| year_from_date(result.release_date))
    };
    let rating = match (result.vote_average, result.vote_count) {
        (Some(average), Some(count)) if count > 0 && average > 0.0 => {
            Some((average * 10.0).round() / 10.0)
        }
        _ => None,
    };

    Some(ScrapeCandidate {
        source_id: result.id,
        title,
        original_title,
        year,
        poster_url: poster_url_from_path(result.poster_path),
        rating,
        overview: non_empty(result.overview),
        kind: kind.to_owned(),
        source: Some("TMDB".to_owned()),
        total_episodes: None,
        platform: None,
    })
}

pub fn map_search_response(body: &str, kind: &str) -> Result<Vec<ScrapeCandidate>, String> {
    let response: TmdbSearchResponse =
        serde_json::from_str(body).map_err(|error| format!("解析 TMDB 返回内容失败：{error}"))?;
    Ok(response
        .results
        .into_iter()
        .filter_map(|result| candidate_from_result(result, kind))
        .take(TMDB_SEARCH_LIMIT)
        .collect())
}

fn describe_request_error(error: &reqwest::Error) -> String {
    if error.is_timeout() {
        return format!("搜索 TMDB 超时（{TMDB_TIMEOUT_SECONDS} 秒），请检查网络后重试。");
    }
    if error.is_connect() {
        return "无法连接 TMDB，请检查网络后重试。".to_owned();
    }
    format!("请求 TMDB 失败：{error}")
}

fn describe_http_status(status: reqwest::StatusCode) -> String {
    match status.as_u16() {
        401 | 403 => format!("TMDB 拒绝访问（HTTP {status}），请检查 API Key 是否正确。"),
        429 => format!("TMDB 请求过于频繁（HTTP {status}），请稍后再试。"),
        _ => format!("TMDB 请求失败（HTTP {status}），请稍后重试。"),
    }
}

pub async fn search_tmdb(
    settings: &AppSettings,
    query: &str,
    media_type: Option<MediaType>,
) -> Result<Vec<ScrapeCandidate>, String> {
    let request = prepare_search(settings, query, media_type)?;
    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(TMDB_TIMEOUT_SECONDS))
        .build()
        .map_err(|error| format!("无法初始化 TMDB 网络请求：{error}"))?;
    let response = client
        .get(&request.url)
        .send()
        .await
        .map_err(|error| describe_request_error(&error))?;
    let status = response.status();
    if !status.is_success() {
        return Err(describe_http_status(status));
    }
    let body = response
        .text()
        .await
        .map_err(|error| describe_request_error(&error))?;
    map_search_response(&body, request.kind)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn configured_settings() -> AppSettings {
        AppSettings {
            tmdb_api_key: " test-key ".to_owned(),
            ..AppSettings::default()
        }
    }

    fn query_pairs(url: &str) -> std::collections::HashMap<String, String> {
        reqwest::Url::parse(url)
            .unwrap()
            .query_pairs()
            .map(|(key, value)| (key.into_owned(), value.into_owned()))
            .collect()
    }

    #[test]
    fn search_requires_api_key_before_network() {
        let error = prepare_search(
            &AppSettings::default(),
            "漫长的季节",
            Some(MediaType::Drama),
        )
        .unwrap_err();
        assert_eq!(error, "请先在设置中填写 TMDB API Key");
    }

    #[test]
    fn novels_are_not_supported_by_tmdb() {
        let error =
            prepare_search(&configured_settings(), "三体", Some(MediaType::Novel)).unwrap_err();
        assert_eq!(error, "小说暂不支持 TMDB 刮削");
    }

    #[test]
    fn blank_queries_are_rejected() {
        let error =
            prepare_search(&configured_settings(), "   ", Some(MediaType::Movie)).unwrap_err();
        assert_eq!(error, "请输入要搜索的标题");
    }

    #[test]
    fn movie_and_tv_searches_use_encoded_documented_parameters() {
        let movie = prepare_search(
            &configured_settings(),
            "沙丘 2 & 帝国",
            Some(MediaType::Movie),
        )
        .unwrap();
        assert!(movie
            .url
            .starts_with("https://api.themoviedb.org/3/search/movie?"));
        assert_eq!(movie.kind, "movie");
        let pairs = query_pairs(&movie.url);
        assert_eq!(pairs.get("api_key").map(String::as_str), Some("test-key"));
        assert_eq!(pairs.get("language").map(String::as_str), Some("zh-CN"));
        assert_eq!(
            pairs.get("include_adult").map(String::as_str),
            Some("false")
        );
        assert_eq!(
            pairs.get("query").map(String::as_str),
            Some("沙丘 2 & 帝国")
        );

        let drama =
            prepare_search(&configured_settings(), "漫长的季节", Some(MediaType::Drama)).unwrap();
        assert!(drama
            .url
            .starts_with("https://api.themoviedb.org/3/search/tv?"));
        assert_eq!(drama.kind, "tv");
    }

    #[test]
    fn response_mapping_normalizes_optional_fields_and_limits_results() {
        let results = (0..12)
            .map(|index| {
                let overview = if index == 0 { "" } else { "简介" };
                serde_json::json!({
                    "id": index,
                    "title": format!("电影 {index}"),
                    "original_title": "",
                    "release_date": "2023-08-04",
                    "poster_path": "/poster.jpg",
                    "vote_average": 8.567,
                    "vote_count": 120,
                    "overview": overview
                })
            })
            .collect::<Vec<_>>();
        let body = serde_json::json!({ "results": results }).to_string();

        let candidates = map_search_response(&body, "movie").unwrap();
        assert_eq!(candidates.len(), 10);
        let first = &candidates[0];
        assert_eq!(first.source_id, 0);
        assert_eq!(first.title, "电影 0");
        assert_eq!(first.original_title, None);
        assert_eq!(first.year, Some(2023));
        assert_eq!(
            first.poster_url.as_deref(),
            Some("https://image.tmdb.org/t/p/w500/poster.jpg")
        );
        assert_eq!(first.rating, Some(8.6));
        assert_eq!(first.overview, None);
        assert_eq!(first.kind, "movie");
    }

    #[test]
    fn response_mapping_handles_tv_names_missing_votes_and_invalid_json() {
        let body = serde_json::json!({
            "results": [
                {
                    "id": 42,
                    "name": "重启人生",
                    "original_name": "ブラッシュアップライフ",
                    "first_air_date": "2023-01-08",
                    "poster_path": null,
                    "vote_average": 0,
                    "vote_count": 0
                }
            ]
        })
        .to_string();

        let candidates = map_search_response(&body, "tv").unwrap();
        assert_eq!(candidates.len(), 1);
        assert_eq!(candidates[0].title, "重启人生");
        assert_eq!(
            candidates[0].original_title.as_deref(),
            Some("ブラッシュアップライフ")
        );
        assert_eq!(candidates[0].year, Some(2023));
        assert_eq!(candidates[0].poster_url, None);
        assert_eq!(candidates[0].rating, None);
        assert_eq!(candidates[0].kind, "tv");

        assert!(map_search_response("not-json", "tv")
            .unwrap_err()
            .contains("解析 TMDB 返回内容失败"));
    }
}
