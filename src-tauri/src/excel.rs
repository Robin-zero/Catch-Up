use base64::{engine::general_purpose, Engine as _};
use calamine::{open_workbook_auto_from_rs, Data, Reader};
use rust_xlsxwriter::{
    Color, DataValidation, Format, FormatAlign, FormatBorder, Workbook, XlsxError,
};

use crate::database::{
    parse_media_type_field, parse_optional_count, parse_optional_rating, parse_optional_season,
    parse_progress_field, EntryInput, EntryStatus, MediaType,
};

/// 单行解析结果：(原始行号, 解析结果)。
pub(crate) type ParsedRow = (usize, Result<EntryInput, String>);

/// 将 base64 文本解码为 Excel 二进制内容。
pub(crate) fn decode_base64(data: &str) -> Result<Vec<u8>, String> {
    general_purpose::STANDARD
        .decode(data.trim())
        .map_err(|error| format!("无法解析 Excel 文件：{error}"))
}

fn template_error(error: XlsxError) -> String {
    format!("生成模板失败：{error}")
}

/// 生成一份导入模板工作簿（xlsx 二进制）。
pub(crate) fn generate_template_bytes() -> Result<Vec<u8>, String> {
    let mut workbook = Workbook::new();
    let worksheet = workbook.add_worksheet();
    worksheet.set_name("追更导入模板").map_err(template_error)?;

    let headers = [
        "标题",
        "类型",
        "季",
        "当前进度",
        "总进度",
        "状态",
        "平台",
        "评分",
        "封面",
        "简介",
    ];

    let header_format = Format::new()
        .set_bold()
        .set_font_color(Color::White)
        .set_background_color(Color::RGB(0x1F4E79))
        .set_align(FormatAlign::Center)
        .set_align(FormatAlign::VerticalCenter)
        .set_border(FormatBorder::Thin)
        .set_border_color(Color::RGB(0x1F4E79));

    let text_format = Format::new()
        .set_align(FormatAlign::VerticalCenter)
        .set_border(FormatBorder::Thin)
        .set_border_color(Color::RGB(0xD9D9D9));

    let integer_format = Format::new()
        .set_num_format("0")
        .set_align(FormatAlign::Center)
        .set_align(FormatAlign::VerticalCenter)
        .set_border(FormatBorder::Thin)
        .set_border_color(Color::RGB(0xD9D9D9));

    let rating_format = Format::new()
        .set_num_format("0.0")
        .set_align(FormatAlign::Center)
        .set_align(FormatAlign::VerticalCenter)
        .set_border(FormatBorder::Thin)
        .set_border_color(Color::RGB(0xD9D9D9));

    // 封面列按文本处理，避免链接被自动转换或过长数字变成科学计数法。
    let link_format = text_format.clone().set_num_format("@");
    let overview_format = text_format.clone().set_text_wrap();

    for (column, header) in headers.iter().enumerate() {
        worksheet
            .write_string_with_format(0, column as u16, *header, &header_format)
            .map_err(template_error)?;
    }
    worksheet.set_row_height(0, 24).map_err(template_error)?;

    // 示例行：数字列写入真正的数值，便于直观看到数字格式。
    worksheet
        .write_string_with_format(1, 0, "庆余年", &text_format)
        .map_err(template_error)?;
    worksheet
        .write_string_with_format(1, 1, "剧集", &text_format)
        .map_err(template_error)?;
    worksheet
        .write_string_with_format(1, 2, "2", &text_format)
        .map_err(template_error)?;
    worksheet
        .write_number_with_format(1, 3, 3, &integer_format)
        .map_err(template_error)?;
    worksheet
        .write_number_with_format(1, 4, 36, &integer_format)
        .map_err(template_error)?;
    worksheet
        .write_string_with_format(1, 5, "在追", &text_format)
        .map_err(template_error)?;
    worksheet
        .write_string_with_format(1, 6, "腾讯视频", &text_format)
        .map_err(template_error)?;
    worksheet
        .write_number_with_format(1, 7, 8.6, &rating_format)
        .map_err(template_error)?;
    worksheet
        .write_string_with_format(1, 8, "https://example.com/cover.jpg", &link_format)
        .map_err(template_error)?;
    worksheet
        .write_string_with_format(1, 9, "一段示例简介", &overview_format)
        .map_err(template_error)?;

    let widths = [22.0, 10.0, 8.0, 10.0, 9.0, 8.0, 12.0, 7.0, 32.0, 32.0];
    for (column, width) in widths.iter().enumerate() {
        worksheet
            .set_column_width(column as u16, *width)
            .map_err(template_error)?;
    }

    // 数字列整列套用格式，用户新增行也能得到一致的数字显示。
    worksheet
        .set_column_format(3, &integer_format)
        .map_err(template_error)?;
    worksheet
        .set_column_format(4, &integer_format)
        .map_err(template_error)?;
    worksheet
        .set_column_format(7, &rating_format)
        .map_err(template_error)?;
    // 封面列按文本处理，避免链接被自动转换或过长数字变成科学计数法。
    worksheet
        .set_column_format(8, &link_format)
        .map_err(template_error)?;

    // 类型、状态下拉选项，覆盖前 1000 行数据区。
    let media_types = ["剧集", "番剧", "综艺", "小说", "电影", "短剧"];
    let statuses = ["在追", "待看", "已完成", "已弃剧"];
    let platforms = [
        "腾讯视频",
        "爱奇艺",
        "优酷",
        "芒果TV",
        "哔哩哔哩",
        "红果短剧",
        "Netflix",
        "其他",
    ];
    let last_row = 1000;

    let media_validation = DataValidation::new()
        .allow_list_strings(&media_types)
        .map_err(template_error)?
        .set_input_title("选择类型")
        .map_err(template_error)?
        .set_input_message("请从下拉列表中选择内容类型")
        .map_err(template_error)?
        .set_error_title("类型无效")
        .map_err(template_error)?
        .set_error_message("请从下拉列表中选择有效的类型")
        .map_err(template_error)?;
    worksheet
        .add_data_validation(1, 1, last_row, 1, &media_validation)
        .map_err(template_error)?;

    let status_validation = DataValidation::new()
        .allow_list_strings(&statuses)
        .map_err(template_error)?
        .set_input_title("选择状态")
        .map_err(template_error)?
        .set_input_message("请从下拉列表中选择追更状态")
        .map_err(template_error)?
        .set_error_title("状态无效")
        .map_err(template_error)?
        .set_error_message("请从下拉列表中选择有效的状态")
        .map_err(template_error)?;
    worksheet
        .add_data_validation(1, 5, last_row, 5, &status_validation)
        .map_err(template_error)?;

    let platform_validation = DataValidation::new()
        .allow_list_strings(&platforms)
        .map_err(template_error)?
        .set_input_title("选择平台")
        .map_err(template_error)?
        .set_input_message("请从下拉列表中选择平台，选填")
        .map_err(template_error)?
        .set_error_title("平台无效")
        .map_err(template_error)?
        .set_error_message("请从下拉列表中选择有效的平台")
        .map_err(template_error)?;
    worksheet
        .add_data_validation(1, 6, last_row, 6, &platform_validation)
        .map_err(template_error)?;

    // 冻结首行与首列（标题列），并给表头加筛选。
    worksheet.set_freeze_panes(1, 1).map_err(template_error)?;
    worksheet.autofilter(0, 0, 1, 9).map_err(template_error)?;

    workbook.save_to_buffer().map_err(template_error)
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum Column {
    Title,
    MediaType,
    Season,
    Current,
    Total,
    Progress,
    Status,
    Platform,
    Rating,
    Cover,
    Overview,
}

fn cell_to_string(cell: &Data) -> String {
    match cell {
        Data::String(value) => value.clone(),
        Data::Int(value) => value.to_string(),
        Data::Float(value) => format_float(*value),
        Data::Bool(value) => value.to_string(),
        Data::DateTimeIso(value) | Data::DurationIso(value) => value.clone(),
        _ => String::new(),
    }
}

fn format_float(value: f64) -> String {
    if value.fract() == 0.0 {
        (value as i64).to_string()
    } else {
        value.to_string()
    }
}

fn header_column(raw: &str) -> Option<Column> {
    let key = raw
        .trim()
        .to_ascii_lowercase()
        .replace([' ', '\t', '_', '-'], "");
    match key.as_str() {
        "标题" | "title" | "name" | "名称" | "剧名" => Some(Column::Title),
        "类型" | "type" | "mediatype" | "类别" | "分类" => Some(Column::MediaType),
        "季" | "季数" | "season" => Some(Column::Season),
        "当前进度" | "当前" | "current" | "currentprogress" | "已看" | "已看集数" | "看到" => {
            Some(Column::Current)
        }
        "总进度" | "总集数" | "总数" | "total" | "totalprogress" | "共多少集" => {
            Some(Column::Total)
        }
        "进度" | "progress" => Some(Column::Progress),
        "状态" | "status" => Some(Column::Status),
        "平台" | "platform" | "来源" => Some(Column::Platform),
        "评分" | "rating" | "分数" => Some(Column::Rating),
        "封面" | "封面地址" | "封面链接" | "cover" | "coverurl" | "poster" | "海报" => {
            Some(Column::Cover)
        }
        "简介" | "overview" | "description" | "描述" | "介绍" => Some(Column::Overview),
        _ => None,
    }
}

fn build_column_map(header: &[Data]) -> (Vec<Option<Column>>, bool) {
    let mapped: Vec<Option<Column>> = header
        .iter()
        .map(|cell| header_column(&cell_to_string(cell)))
        .collect();
    if mapped.iter().any(|column| column.is_some()) {
        return (mapped, true);
    }

    let positional = [
        Column::Title,
        Column::MediaType,
        Column::Season,
        Column::Progress,
        Column::Platform,
        Column::Rating,
    ]
    .into_iter()
    .map(Some)
    .collect();
    (positional, false)
}

fn parse_status_field(raw: &str) -> Result<EntryStatus, String> {
    match raw.trim() {
        "" | "tracking" | "在追" | "追更中" | "追更" | "进行中" | "观看中" => {
            Ok(EntryStatus::Tracking)
        }
        "completed" | "已完成" | "看完" | "已看完" | "完结" => Ok(EntryStatus::Completed),
        "dropped" | "弃剧" | "已弃剧" | "放弃" | "弃看" => Ok(EntryStatus::Dropped),
        "to_watch" | "待看" | "想看" | "待追" | "计划看" | "未看" => {
            Ok(EntryStatus::ToWatch)
        }
        other => Err(format!("未知状态：{other}")),
    }
}

/// 解析整个工作簿，返回 (原始行号, 解析结果)；错误行由调用方计入跳过与错误清单。
pub(crate) fn parse_workbook(
    bytes: &[u8],
    default_media_type: MediaType,
) -> Result<Vec<ParsedRow>, String> {
    let mut workbook = open_workbook_auto_from_rs(std::io::Cursor::new(bytes))
        .map_err(|error| format!("无法解析 Excel 文件：{error}"))?;
    let sheet_name = workbook
        .sheet_names()
        .first()
        .cloned()
        .ok_or_else(|| "Excel 文件没有可用的工作表".to_owned())?;
    let range = workbook
        .worksheet_range(&sheet_name)
        .map_err(|error| format!("读取工作表失败：{error}"))?;

    let mut rows = range.rows();
    let header_row = match rows.next() {
        Some(row) => row,
        None => return Ok(Vec::new()),
    };
    let (column_map, skip_header) = build_column_map(header_row);

    let start_line = if skip_header { 2 } else { 1 };
    let data_rows: Vec<&[Data]> = if skip_header {
        rows.collect()
    } else {
        std::iter::once(header_row).chain(rows).collect()
    };

    let mut parsed = Vec::new();
    for (offset, row) in data_rows.into_iter().enumerate() {
        let line_number = start_line + offset;
        let is_blank = row
            .iter()
            .all(|cell| cell_to_string(cell).trim().is_empty());
        if !is_blank {
            parsed.push((line_number, parse_row(row, &column_map, default_media_type)));
        }
    }

    Ok(parsed)
}

fn parse_row(
    row: &[Data],
    column_map: &[Option<Column>],
    default_media_type: MediaType,
) -> Result<EntryInput, String> {
    let mut title = String::new();
    let mut media_type: Option<String> = None;
    let mut season: Option<String> = None;
    let mut current: Option<String> = None;
    let mut total: Option<String> = None;
    let mut progress_combined: Option<String> = None;
    let mut status: Option<String> = None;
    let mut platform: Option<String> = None;
    let mut rating: Option<String> = None;
    let mut cover: Option<String> = None;
    let mut overview: Option<String> = None;

    for (index, cell) in row.iter().enumerate() {
        let Some(column) = column_map.get(index).copied().flatten() else {
            continue;
        };
        let text = cell_to_string(cell);
        match column {
            Column::Title => title = text,
            Column::MediaType => media_type = Some(text),
            Column::Season => season = Some(text),
            Column::Current => current = Some(text),
            Column::Total => total = Some(text),
            Column::Progress => progress_combined = Some(text),
            Column::Status => status = Some(text),
            Column::Platform => platform = Some(text),
            Column::Rating => rating = Some(text),
            Column::Cover => cover = Some(text),
            Column::Overview => overview = Some(text),
        }
    }

    let title = title.trim().to_owned();
    if title.is_empty() {
        return Err("标题不能为空".to_owned());
    }

    let media_type = match media_type {
        Some(value) if !value.trim().is_empty() => parse_media_type_field(&value)?,
        _ => default_media_type,
    };
    let season = season
        .as_deref()
        .map(parse_optional_season)
        .transpose()?
        .flatten();
    let (current_progress, total_progress) = if let Some(value) = &progress_combined {
        parse_progress_field(value)?
    } else {
        let current_progress = current
            .as_deref()
            .map(|value| parse_optional_count(value, "当前进度"))
            .transpose()?
            .flatten()
            .unwrap_or(0);
        let total_progress = total
            .as_deref()
            .map(|value| parse_optional_count(value, "总进度"))
            .transpose()?
            .flatten();
        (current_progress, total_progress)
    };
    let status = match status {
        Some(value) if !value.trim().is_empty() => parse_status_field(&value)?,
        _ => EntryStatus::Tracking,
    };
    let rating = rating
        .as_deref()
        .map(parse_optional_rating)
        .transpose()?
        .flatten();
    let platform = platform
        .map(|value| value.trim().to_owned())
        .filter(|value| !value.is_empty());
    let cover_url = cover
        .map(|value| value.trim().to_owned())
        .filter(|value| !value.is_empty());
    let overview = overview
        .map(|value| value.trim().to_owned())
        .filter(|value| !value.is_empty());

    Ok(EntryInput {
        title,
        media_type,
        current_progress,
        total_progress,
        status,
        season,
        rating,
        platform,
        cover_url,
        overview,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::database::MediaType;

    fn make_workbook(rows: &[&[&str]]) -> Vec<u8> {
        let mut workbook = Workbook::new();
        let worksheet = workbook.add_worksheet();
        for (row_index, row) in rows.iter().enumerate() {
            for (column, value) in row.iter().enumerate() {
                worksheet
                    .write_string(row_index as u32, column as u16, *value)
                    .unwrap();
            }
        }
        workbook.save_to_buffer().unwrap()
    }

    #[test]
    fn parses_header_mapped_workbook() {
        let bytes = make_workbook(&[
            &[
                "标题",
                "类型",
                "季",
                "当前进度",
                "总进度",
                "状态",
                "平台",
                "评分",
                "封面",
                "简介",
            ],
            &[
                "庆余年",
                "剧集",
                "2",
                "3",
                "36",
                "在追",
                "腾讯视频",
                "8.6",
                "https://example.com/a.jpg",
                "简介",
            ],
            &["无名之剧", "", "年番", "", "", "待看", "", "", "", ""],
        ]);
        let parsed = parse_workbook(&bytes, MediaType::Drama).unwrap();
        assert_eq!(parsed.len(), 2);
        let first = parsed[0].1.as_ref().unwrap();
        assert_eq!(first.title, "庆余年");
        assert_eq!(first.media_type, MediaType::Drama);
        assert_eq!(first.season.as_deref(), Some("2"));
        assert_eq!(first.current_progress, 3);
        assert_eq!(first.total_progress, Some(36));
        assert_eq!(first.status, EntryStatus::Tracking);
        assert_eq!(first.platform.as_deref(), Some("腾讯视频"));
        assert_eq!(first.rating, Some(8.6));
        assert_eq!(
            first.cover_url.as_deref(),
            Some("https://example.com/a.jpg")
        );
        assert_eq!(first.overview.as_deref(), Some("简介"));

        let second = parsed[1].1.as_ref().unwrap();
        assert_eq!(second.title, "无名之剧");
        assert_eq!(second.season.as_deref(), Some("年番"));
        assert_eq!(second.status, EntryStatus::ToWatch);
        assert_eq!(second.current_progress, 0);
        assert_eq!(second.total_progress, None);
    }

    #[test]
    fn parses_positional_workbook_without_header() {
        let bytes = make_workbook(&[
            &["漫长的季节", "剧集", "", "3/12", "腾讯视频", "9.4"],
            &["诡秘之主", "小说", "", "第12章", "", "9.1"],
        ]);
        let parsed = parse_workbook(&bytes, MediaType::Drama).unwrap();
        assert_eq!(parsed.len(), 2);
        assert_eq!(parsed[0].1.as_ref().unwrap().title, "漫长的季节");
        assert_eq!(parsed[0].1.as_ref().unwrap().current_progress, 3);
        assert_eq!(parsed[0].1.as_ref().unwrap().total_progress, Some(12));
        assert_eq!(
            parsed[0].1.as_ref().unwrap().platform.as_deref(),
            Some("腾讯视频")
        );
        assert_eq!(parsed[0].1.as_ref().unwrap().rating, Some(9.4));
        assert_eq!(parsed[1].1.as_ref().unwrap().media_type, MediaType::Novel);
        assert_eq!(parsed[1].1.as_ref().unwrap().current_progress, 12);
    }

    #[test]
    fn reports_missing_title_with_line_number() {
        let bytes = make_workbook(&[&["标题", "类型"], &["", "剧集"], &["有效条目", ""]]);
        let parsed = parse_workbook(&bytes, MediaType::Drama).unwrap();
        assert_eq!(parsed.len(), 2);
        assert_eq!(parsed[0].0, 2);
        assert!(parsed[0].1.is_err());
        assert!(parsed[0].1.as_ref().unwrap_err().contains("标题不能为空"));
        assert!(parsed[1].1.is_ok());
    }

    #[test]
    fn template_generates_a_non_empty_xlsx() {
        let bytes = generate_template_bytes().unwrap();
        assert!(bytes.len() > 100);
        let parsed = parse_workbook(&bytes, MediaType::Drama).unwrap();
        // 模板第一行是表头，第二行是示例，应能解析出示例条目。
        assert_eq!(parsed.len(), 1);
        assert_eq!(parsed[0].1.as_ref().unwrap().title, "庆余年");
    }
}
