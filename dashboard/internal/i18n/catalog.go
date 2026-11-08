package i18n

import (
	"fmt"
	"math"
	"strings"
	"time"
)

// Catalog holds all localized UI strings, labels, table headers, and formats
// for the Go TUI Dashboard. It provides a static, zero-dependency translation architecture.
type Catalog struct {
	// Screen banners & general
	AppTitle       string
	OffersSummary  string
	NoOffersMatch  string
	LoadingPreview string

	// Tabs & filters
	TabAll        string
	TabEvaluated  string
	TabApplied    string
	TabInterview  string
	TabResponded  string
	TabAssessment string
	TabTop        string
	TabSkip       string
	TabRejected   string
	TabLapsed     string
	TabDiscarded  string

	// Table column headers
	ColFit      string
	ColDate     string
	ColCompany  string
	ColRole     string
	ColStatus   string
	ColLocation string
	ColPay      string
	ColPosted   string
	ColLast     string

	// Preview labels
	LabelLoc     string
	LabelPay     string
	LabelLast    string
	LabelRemote  string
	LabelOutcome string

	// Work modes
	ModeRemote     string
	ModeRemoteFlex string
	ModeHybrid     string
	ModeFull       string

	// Progress screen
	ProgressTitle   string
	ProgressSummary string
	FunnelTitle     string
	ScoresTitle     string
	RatesTitle      string
	WeeklyTitle     string
	ActiveInfo      string

	// Stats screen
	StatsTitle             string
	StatsSummary           string
	StatsStrategicInsights string
	FitQualityDistribution string
	SeniorityMix           string
	QualityBreakdown       string
	MeetQualityBar         string
	SalaryBandDist         string
	ArchetypeTitle         string
	WorkModeTitle          string
	LocationTitle          string
	PayTitle               string
	ColArchetype           string
	ColCount               string
	ColAvgScore            string
	PayCount               string
	PayAvg                 string
	PayMedian              string
	PayMax                 string
	PaySourceSplit         string
	InsightVolumeFit       string
	InsightVolumePrimary   string
	InsightWorkMode        string
	InsightPayBenchmark    string

	// Seniority levels
	SeniorityExecutive      string
	SeniorityStaffPrincipal string
	SeniorityLeadManager    string
	SenioritySenior         string
	SeniorityMidLevel       string
	SeniorityJuniorEntry    string

	// Relative dates
	TimeToday     string
	TimeYesterday string
	TimeDaysAgo   string

	// Status display names
	StatusEvaluated  string
	StatusApplied    string
	StatusResponded  string
	StatusAssessment string
	StatusInterview  string
	StatusOffer      string
	StatusRejected   string
	StatusLapsed     string
	StatusDiscarded  string
	StatusSkip       string
	StatusHired      string

	// Additional UI strings
	NoData        string
	EmptyFile     string
	RateResponse  string
	RateInterview string
	RateOffer     string

	// Footer descriptions & hints
	HelpNav        string
	HelpTabs       string
	HelpSearch     string
	HelpSort       string
	HelpRefresh    string
	HelpReport     string
	HelpOpenURL    string
	HelpOpenPDF    string
	HelpRegenPDF   string
	HelpChange     string
	HelpColumns    string
	HelpView       string
	HelpProgress   string
	HelpStats      string
	HelpQuit       string
	HelpScroll     string
	HelpPage       string
	HelpTopEnd     string
	HelpLanguage   string
	HelpManifesto  string
	HelpBack       string
	HelpNavigate   string
	HelpToggle     string
	HelpClose      string
	HelpConfirm    string
	HelpCancel     string
	HelpFilterLive string
	HelpKeep       string
	HelpClear      string

	// Picker overlay titles & bar hints
	PickerChangeStatus string
	PickerColumnsTitle string
	SearchHintInput    string
	SearchHintNormal   string
	SearchMatching     string
	SortLabel          string
	ViewLabel          string
	ShownCount         string
	ColReport          string
	ColPDF             string

	// Sort & view modes
	SortScore    string
	SortDate     string
	SortCompany  string
	SortStatus   string
	SortLocation string
	SortPay      string
	SortLast     string
	SortPosted   string
	ViewGrouped  string
	ViewFlat     string
}

// SortModeLabel returns the localized display label for a sort mode ("score", "date", etc.).
func (c *Catalog) SortModeLabel(mode string) string {
	switch strings.ToLower(strings.TrimSpace(mode)) {
	case "score":
		return c.SortScore
	case "date":
		return c.SortDate
	case "company":
		return c.SortCompany
	case "status":
		return c.SortStatus
	case "location":
		return c.SortLocation
	case "pay":
		return c.SortPay
	case "last":
		return c.SortLast
	case "posted":
		return c.SortPosted
	default:
		return mode
	}
}

// ViewModeLabel returns the localized display label for a view mode ("grouped" or "flat").
func (c *Catalog) ViewModeLabel(mode string) string {
	switch strings.ToLower(strings.TrimSpace(mode)) {
	case "grouped":
		return c.ViewGrouped
	case "flat":
		return c.ViewFlat
	default:
		return mode
	}
}

// StatusLabel returns the localized display label for a canonical status ID
// (interview, offer, hired, responded, assessment, applied, evaluated, skip,
// rejected, discarded).
func (c *Catalog) StatusLabel(norm string) string {
	switch strings.ToLower(strings.TrimSpace(norm)) {
	case "interview":
		return c.StatusInterview
	case "offer":
		return c.StatusOffer
	case "hired":
		return c.StatusHired
	case "responded":
		return c.StatusResponded
	case "assessment":
		return c.StatusAssessment
	case "applied":
		return c.StatusApplied
	case "evaluated":
		return c.StatusEvaluated
	case "skip":
		return c.StatusSkip
	case "rejected":
		return c.StatusRejected
	case "lapsed":
		return c.StatusLapsed
	case "discarded":
		return c.StatusDiscarded
	default:
		return norm
	}
}

// NowFunc allows injecting a mock clock for testing.
var NowFunc = time.Now

// FormatTimeAgo renders an ISO date as a relative duration in calendar days using localized strings:
// "today", "yesterday", or "Nd ago" (or Turkish equivalents).
func (c *Catalog) FormatTimeAgo(dateStr string) string {
	t, err := time.ParseInLocation("2006-01-02", dateStr, time.Local)
	if err != nil {
		return dateStr
	}
	now := NowFunc()
	today := time.Date(now.Year(), now.Month(), now.Day(), 0, 0, 0, 0, time.Local)
	contactDay := time.Date(t.Year(), t.Month(), t.Day(), 0, 0, 0, 0, time.Local)
	days := int(math.Round(today.Sub(contactDay).Hours() / 24))
	switch {
	case days <= 0:
		return c.TimeToday
	case days == 1:
		return c.TimeYesterday
	default:
		return fmt.Sprintf(c.TimeDaysAgo, days)
	}
}

// PieChartSectionTitle formats a section title with the standard pie chart icon.
func PieChartSectionTitle(title string) string {
	return "≡ƒÄ» " + title
}

// SeniorityLabel returns the localized display label for a seniority category.
func (c *Catalog) SeniorityLabel(s string) string {
	switch s {
	case "Executive":
		return c.SeniorityExecutive
	case "Staff / Principal":
		return c.SeniorityStaffPrincipal
	case "Lead / Manager":
		return c.SeniorityLeadManager
	case "Senior":
		return c.SenioritySenior
	case "Mid-Level":
		return c.SeniorityMidLevel
	case "Junior / Entry":
		return c.SeniorityJuniorEntry
	default:
		return s
	}
}

// En is the static English translation catalog.
var En = Catalog{
	// Screen banners & general
	AppTitle:       "CAREER PIPELINE",
	OffersSummary:  "%d offers | Avg %s/5",
	NoOffersMatch:  "No offers match this filter",
	LoadingPreview: "Loading preview...",

	// Tabs & filters
	TabAll:        "ALL",
	TabEvaluated:  "EVALUATED",
	TabApplied:    "APPLIED",
	TabInterview:  "INTERVIEW",
	TabResponded:  "RESPONDED",
	TabAssessment: "ASSESSMENT",
	TabTop:        "TOP ΓëÑ4",
	TabSkip:       "SKIP",
	TabRejected:   "REJECTED",
	TabLapsed:     "LAPSED",
	TabDiscarded:  "DISCARDED",

	// Table column headers
	ColFit:      "FIT",
	ColDate:     "DATE",
	ColCompany:  "COMPANY",
	ColRole:     "ROLE",
	ColStatus:   "STATUS",
	ColLocation: "LOCATION",
	ColPay:      "PAY",
	ColPosted:   "POSTED",
	ColLast:     "LAST",

	// Preview labels
	LabelLoc:     "Loc: ",
	LabelPay:     "Pay: ",
	LabelLast:    "Last contact: ",
	LabelRemote:  "Remote: ",
	LabelOutcome: "Outcome: ",

	// Work modes
	ModeRemote:     "Remote",
	ModeRemoteFlex: "RemoteFlex",
	ModeHybrid:     "Hybrid",
	ModeFull:       "Full",

	// Progress screen
	ProgressTitle:   "SEARCH PROGRESS",
	ProgressSummary: "%d tracked | %.1f avg score",
	FunnelTitle:     "Pipeline Funnel",
	ScoresTitle:     "Score Distribution",
	RatesTitle:      "Conversion Rates",
	WeeklyTitle:     "Weekly Activity",
	ActiveInfo:      "%d active applications | %d total offers",

	// Stats screen
	StatsTitle:             "SEARCH STATS",
	StatsSummary:           "%d evaluated | %d archetypes",
	StatsStrategicInsights: "STRATEGIC INSIGHTS",
	FitQualityDistribution: "Fit Quality Distribution",
	SeniorityMix:           "Seniority Mix",
	QualityBreakdown:       "Quality Breakdown:",
	MeetQualityBar:         "Γ£ô %.0f%% meet ΓëÑ4.0 bar",
	SalaryBandDist:         "Salary Band Distribution:",
	ArchetypeTitle:         "By Archetype",
	WorkModeTitle:          "By Work Mode",
	LocationTitle:          "By Location",
	PayTitle:               "Pay Range (posted top, $)",
	ColArchetype:           "ARCHETYPE",
	ColCount:               "COUNT",
	ColAvgScore:            "AVG FIT",
	PayCount:               "Data points: ",
	PayAvg:                 "Avg: ",
	PayMedian:              "Median: ",
	PayMax:                 "Max: ",
	PaySourceSplit:         "%d posted, %d estimated",
	InsightVolumeFit:       "Primary volume in %s (%d roles, %.0f%%) ┬╖ Highest fit in %s (%.1f/5 avg fit)",
	InsightVolumePrimary:   "Primary archetype is %s (%d roles, %.0f%% of evaluated pipeline)",
	InsightWorkMode:        "Workplace distribution: %.0f%% of roles operate as %s",
	InsightPayBenchmark:    "Compensation benchmark: Median top pay is $%.0fK (peak $%.0fK) across %d data points",

	// Seniority levels
	SeniorityExecutive:      "Executive",
	SeniorityStaffPrincipal: "Staff / Principal",
	SeniorityLeadManager:    "Lead / Manager",
	SenioritySenior:         "Senior",
	SeniorityMidLevel:       "Mid-Level",
	SeniorityJuniorEntry:    "Junior / Entry",

	// Relative dates
	TimeToday:     "today",
	TimeYesterday: "yesterday",
	TimeDaysAgo:   "%dd ago",

	// Status display names
	StatusEvaluated:  "Evaluated",
	StatusApplied:    "Applied",
	StatusResponded:  "Responded",
	StatusAssessment: "Assessment",
	StatusInterview:  "Interview",
	StatusOffer:      "Offer",
	StatusRejected:   "Rejected",
	StatusLapsed:     "Lapsed",
	StatusDiscarded:  "Discarded",
	StatusSkip:       "SKIP",
	StatusHired:      "Hired",

	// Additional UI strings
	NoData:        "No data",
	EmptyFile:     "(empty file)",
	RateResponse:  "Response Rate: ",
	RateInterview: "Interview Rate: ",
	RateOffer:     "Offer Rate: ",

	// Footer descriptions & hints
	HelpNav:        " nav  ",
	HelpTabs:       " tabs  ",
	HelpSearch:     " search  ",
	HelpSort:       " sort  ",
	HelpRefresh:    " refresh  ",
	HelpReport:     " report  ",
	HelpOpenURL:    " open URL  ",
	HelpOpenPDF:    " open PDF  ",
	HelpRegenPDF:   " regen PDF  ",
	HelpChange:     " change  ",
	HelpColumns:    " columns  ",
	HelpView:       " view  ",
	HelpProgress:   " progress  ",
	HelpStats:      " stats  ",
	HelpQuit:       " quit",
	HelpScroll:     " scroll  ",
	HelpPage:       " page  ",
	HelpTopEnd:     " top/end  ",
	HelpLanguage:   " lang  ",
	HelpManifesto:  " manifesto  ",
	HelpBack:       " back",
	HelpNavigate:   " navigate  ",
	HelpToggle:     " toggle  ",
	HelpClose:      " close",
	HelpConfirm:    " confirm  ",
	HelpCancel:     " cancel",
	HelpFilterLive: " filter live  ",
	HelpKeep:       " keep  ",
	HelpClear:      " clear  ",

	// Picker overlay titles & bar hints
	PickerChangeStatus: "Change status:",
	PickerColumnsTitle: "ΓöÇΓöÇΓöÇ Columns (SPACE toggle ┬╖ ESC close) ΓöÇΓöÇΓöÇ",
	SearchHintInput:    "   Enter: keep   Esc: cancel   Ctrl+U: clear",
	SearchHintNormal:   "   Esc: clear   /: edit",
	SearchMatching:     "  %d/%d matching",
	SortLabel:          "[Sort: %s]",
	ViewLabel:          "[View: %s]",
	ShownCount:         "%d shown",
	ColReport:          "RPT",
	ColPDF:             "PDF",

	// Sort & view modes
	SortScore:    "score",
	SortDate:     "date",
	SortCompany:  "company",
	SortStatus:   "status",
	SortLocation: "location",
	SortPay:      "pay",
	SortLast:     "last",
	SortPosted:   "posted",
	ViewGrouped:  "grouped",
	ViewFlat:     "flat",
}

// Tr is the static Turkish translation catalog.
var Tr = Catalog{
	// Screen banners & general
	AppTitle:       "KAR─░YER HATTI",
	OffersSummary:  "%d ilan | Ort %s/5",
	NoOffersMatch:  "Bu filtreye uyan ilan yok",
	LoadingPreview: "├ûnizleme y├╝kleniyor...",

	// Tabs & filters
	TabAll:        "T├£M├£",
	TabEvaluated:  "DE─₧ERLEND─░R─░LD─░",
	TabApplied:    "BA┼₧VURULDU",
	TabInterview:  "M├£LAKAT",
	TabResponded:  "YANIT VER─░LD─░",
	TabAssessment: "DE─₧ERLEND─░RME",
	TabTop:        "EN ─░Y─░ ΓëÑ4",
	TabSkip:       "UYGUN DE─₧─░L",
	TabRejected:   "REDDED─░LD─░",
	TabLapsed:     "S├£RES─░ DOLDU",
	TabDiscarded:  "─░PTAL",

	// Table column headers
	ColFit:      "UYUM",
	ColDate:     "TAR─░H",
	ColCompany:  "┼₧─░RKET",
	ColRole:     "POZ─░SYON",
	ColStatus:   "DURUM",
	ColLocation: "KONUM",
	ColPay:      "├£CRET",
	ColPosted:   "YAYIN",
	ColLast:     "SON",

	// Preview labels
	LabelLoc:     "Konum: ",
	LabelPay:     "├£cret: ",
	LabelLast:    "Son ileti┼ƒim: ",
	LabelRemote:  "├çal─▒┼ƒma ┼₧ekli: ",
	LabelOutcome: "Sonu├º: ",

	// Work modes
	ModeRemote:     "Uzaktan",
	ModeRemoteFlex: "Uzaktan (Esnek)",
	ModeHybrid:     "Hibrit",
	ModeFull:       "Ofiste",

	// Progress screen
	ProgressTitle:   "TAK─░P ─░LERLEMES─░",
	ProgressSummary: "%d takipte | %.1f ort. puan",
	FunnelTitle:     "Pipeline Hunisi",
	ScoresTitle:     "Puan Da─ƒ─▒l─▒m─▒",
	RatesTitle:      "D├╢n├╝┼ƒ├╝m Oranlar─▒",
	WeeklyTitle:     "Haftal─▒k Aktivite",
	ActiveInfo:      "%d aktif ba┼ƒvuru | %d toplam teklif",

	// Stats screen
	StatsTitle:             "TAK─░P ─░STAT─░ST─░KLER─░",
	StatsSummary:           "%d de─ƒerlendirildi | %d arketip",
	StatsStrategicInsights: "STRATEJ─░K ─░├çG├ûR├£LER",
	FitQualityDistribution: "Uyum Kalitesi Da─ƒ─▒l─▒m─▒",
	SeniorityMix:           "K─▒dem Da─ƒ─▒l─▒m─▒",
	QualityBreakdown:       "Kalite Da─ƒ─▒l─▒m─▒:",
	MeetQualityBar:         "Γ£ô %%%.0f ΓëÑ4.0 baraj─▒n─▒ ge├ºiyor",
	SalaryBandDist:         "Maa┼ƒ Aral─▒─ƒ─▒ Da─ƒ─▒l─▒m─▒:",
	ArchetypeTitle:         "Arketipe G├╢re",
	WorkModeTitle:          "├çal─▒┼ƒma ┼₧ekline G├╢re",
	LocationTitle:          "Konuma G├╢re",
	PayTitle:               "├£cret Aral─▒─ƒ─▒ (ilan ├╝st s─▒n─▒r─▒, $)",
	ColArchetype:           "ARKET─░P",
	ColCount:               "SAYI",
	ColAvgScore:            "ORT. UYUM",
	PayCount:               "Veri noktas─▒: ",
	PayAvg:                 "Ort: ",
	PayMedian:              "Medyan: ",
	PayMax:                 "Maks: ",
	PaySourceSplit:         "%d ilan, %d tahmini",
	InsightVolumeFit:       "En y├╝ksek hacim %s alan─▒nda (%d ilan, %%%.0f) ┬╖ En y├╝ksek uyum %s alan─▒nda (ort. %.1f/5)",
	InsightVolumePrimary:   "Ana arketip %s (%d ilan, de─ƒerlendirilen hatt─▒n %%%.0f'i)",
	InsightWorkMode:        "├çal─▒┼ƒma yeri da─ƒ─▒l─▒m─▒: ilanlar─▒n %%%.0f'i %s olarak ├ºal─▒┼ƒ─▒yor",
	InsightPayBenchmark:    "├£cret kar┼ƒ─▒la┼ƒt─▒rmas─▒: medyan ├╝st maa┼ƒ $%.0fK (en y├╝ksek $%.0fK) ΓÇö %d veri noktas─▒",

	// Seniority levels
	SeniorityExecutive:      "Y├╢netici",
	SeniorityStaffPrincipal: "K─▒demli Uzman / Lider",
	SeniorityLeadManager:    "Tak─▒m Lideri / M├╝d├╝r",
	SenioritySenior:         "K─▒demli",
	SeniorityMidLevel:       "Orta Seviye",
	SeniorityJuniorEntry:    "Ba┼ƒlang─▒├º / Giri┼ƒ",

	// Relative dates
	TimeToday:     "bug├╝n",
	TimeYesterday: "d├╝n",
	TimeDaysAgo:   "%d g├╝n ├╢nce",

	// Status display names
	StatusEvaluated:  "De─ƒerlendirildi",
	StatusApplied:    "Ba┼ƒvuruldu",
	StatusResponded:  "Yan─▒t Verildi",
	StatusAssessment: "De─ƒerlendirme",
	StatusInterview:  "M├╝lakat",
	StatusOffer:      "Teklif",
	StatusRejected:   "Reddedildi",
	StatusLapsed:     "Suresi Doldu",
	StatusDiscarded:  "─░ptal Edildi",
	StatusSkip:       "Uygun De─ƒil",
	StatusHired:      "─░┼ƒe Al─▒nd─▒",

	// Additional UI strings
	NoData:        "Veri yok",
	EmptyFile:     "(bo┼ƒ dosya)",
	RateResponse:  "Yan─▒t Oran─▒: ",
	RateInterview: "M├╝lakat Oran─▒: ",
	RateOffer:     "Teklif Oran─▒: ",

	// Footer descriptions & hints
	HelpNav:        " gezin  ",
	HelpTabs:       " sekmeler  ",
	HelpSearch:     " ara  ",
	HelpSort:       " s─▒rala  ",
	HelpRefresh:    " yenile  ",
	HelpReport:     " rapor  ",
	HelpOpenURL:    " URL a├º  ",
	HelpOpenPDF:    " PDF'i a├º  ",
	HelpRegenPDF:   " PDF ├╝ret  ",
	HelpChange:     " durum  ",
	HelpColumns:    " s├╝tunlar  ",
	HelpView:       " g├╢r├╝n├╝m  ",
	HelpProgress:   " ilerleme  ",
	HelpStats:      " istatistik  ",
	HelpQuit:       " ├º─▒k─▒┼ƒ",
	HelpScroll:     " kayd─▒r  ",
	HelpPage:       " sayfa  ",
	HelpTopEnd:     " ba┼ƒ/son  ",
	HelpLanguage:   " dil  ",
	HelpManifesto:  " manifesto  ",
	HelpBack:       " geri",
	HelpNavigate:   " gezin  ",
	HelpToggle:     " de─ƒi┼ƒtir  ",
	HelpClose:      " kapat",
	HelpConfirm:    " onayla  ",
	HelpCancel:     " iptal",
	HelpFilterLive: " canl─▒ filtrele  ",
	HelpKeep:       " kaydet  ",
	HelpClear:      " temizle  ",

	// Picker overlay titles & bar hints
	PickerChangeStatus: "Durumu de─ƒi┼ƒtir:",
	PickerColumnsTitle: "ΓöÇΓöÇΓöÇ S├╝tunlar (SPACE de─ƒi┼ƒtir ┬╖ ESC kapat) ΓöÇΓöÇΓöÇ",
	SearchHintInput:    "   Enter: kaydet   Esc: iptal   Ctrl+U: temizle",
	SearchHintNormal:   "   Esc: temizle   /: d├╝zenle",
	SearchMatching:     "  %d/%d e┼ƒle┼ƒen",
	SortLabel:          "[S─▒rala: %s]",
	ViewLabel:          "[G├╢r├╝n├╝m: %s]",
	ShownCount:         "%d g├╢sterilen",
	ColReport:          "RAP",
	ColPDF:             "PDF",

	// Sort & view modes
	SortScore:    "puan",
	SortDate:     "tarih",
	SortCompany:  "┼ƒirket",
	SortStatus:   "durum",
	SortLocation: "konum",
	SortPay:      "├╝cret",
	SortLast:     "son",
	SortPosted:   "yay─▒n",
	ViewGrouped:  "gruplu",
	ViewFlat:     "d├╝z",
}

// Es is the static Spanish translation catalog.
var Es = Catalog{
	// Screen banners & general
	AppTitle:       "FLUJO DE CARRERA",
	OffersSummary:  "%d ofertas | Prom %s/5",
	NoOffersMatch:  "Ninguna oferta coincide con este filtro",
	LoadingPreview: "Cargando vista previa...",

	// Tabs & filters
	TabAll:        "TODAS",
	TabEvaluated:  "EVALUADAS",
	TabApplied:    "APLICADAS",
	TabInterview:  "ENTREVISTA",
	TabResponded:  "RESPONDIDAS",
	TabAssessment: "PRUEBA",
	TabTop:        "TOP ΓëÑ4",
	TabSkip:       "OMITIR",
	TabRejected:   "RECHAZADAS",
	TabLapsed:     "CADUCADAS",
	TabDiscarded:  "DESCARTADAS",

	// Table column headers
	ColFit:      "AJUSTE",
	ColDate:     "FECHA",
	ColCompany:  "EMPRESA",
	ColRole:     "PUESTO",
	ColStatus:   "ESTADO",
	ColLocation: "UBICACI├ôN",
	ColPay:      "SALARIO",
	ColPosted:   "PUBLIC.",
	ColLast:     "├ÜLTIMO",

	// Preview labels
	LabelLoc:     "Ubic: ",
	LabelPay:     "Salario: ",
	LabelLast:    "├Ültimo contacto: ",
	LabelRemote:  "Remoto: ",
	LabelOutcome: "Resultado: ",

	// Work modes
	ModeRemote:     "Remoto",
	ModeRemoteFlex: "Remoto (Flex)",
	ModeHybrid:     "H├¡brido",
	ModeFull:       "Presencial",

	// Progress screen
	ProgressTitle:   "PROGRESO DE B├ÜSQUEDA",
	ProgressSummary: "%d en seguimiento | %.1f puntuaci├│n media",
	FunnelTitle:     "Embudo del proceso",
	ScoresTitle:     "Distribuci├│n de puntuaciones",
	RatesTitle:      "Tasas de conversi├│n",
	WeeklyTitle:     "Actividad semanal",
	ActiveInfo:      "%d solicitudes activas | %d ofertas totales",

	// Stats screen
	StatsTitle:             "ESTAD├ìSTICAS DE B├ÜSQUEDA",
	StatsSummary:           "%d evaluadas | %d arquetipos",
	StatsStrategicInsights: "INSIGHTS ESTRAT├ëGICOS",
	FitQualityDistribution: "Distribuci├│n de Calidad de Ajuste",
	SeniorityMix:           "Mix de Antig├╝edad",
	QualityBreakdown:       "Desglose de Calidad:",
	MeetQualityBar:         "Γ£ô %.0f%% supera el umbral de ΓëÑ4.0",
	SalaryBandDist:         "Distribuci├│n por Rangos Salariales:",
	ArchetypeTitle:         "Por Arquetipo",
	WorkModeTitle:          "Por Modalidad",
	LocationTitle:          "Por Ubicaci├│n",
	PayTitle:               "Rango salarial (tope publicado, $)",
	ColArchetype:           "ARQUETIPO",
	ColCount:               "CANTIDAD",
	ColAvgScore:            "AJUSTE PROM",
	PayCount:               "Puntos de datos: ",
	PayAvg:                 "Prom: ",
	PayMedian:              "Mediana: ",
	PayMax:                 "M├íx: ",
	PaySourceSplit:         "%d publicados, %d estimados",
	InsightVolumeFit:       "Mayor volumen en %s (%d puestos, %.0f%%) ┬╖ Mayor ajuste en %s (ajuste prom. %.1f/5)",
	InsightVolumePrimary:   "Arquetipo principal: %s (%d puestos, %.0f%% del flujo evaluado)",
	InsightWorkMode:        "Distribuci├│n laboral: el %.0f%% de los puestos opera como %s",
	InsightPayBenchmark:    "Referencia salarial: La mediana de salario m├íximo es $%.0fK (pico $%.0fK) en %d puntos de datos",

	// Seniority levels
	SeniorityExecutive:      "Ejecutivo",
	SeniorityStaffPrincipal: "Staff / Principal",
	SeniorityLeadManager:    "L├¡der / Manager",
	SenioritySenior:         "Senior",
	SeniorityMidLevel:       "Nivel Medio",
	SeniorityJuniorEntry:    "Junior / Inicial",

	// Relative dates
	TimeToday:     "hoy",
	TimeYesterday: "ayer",
	TimeDaysAgo:   "hace %dd",

	// Status display names
	StatusEvaluated:  "Evaluada",
	StatusApplied:    "Aplicada",
	StatusResponded:  "Respondida",
	StatusAssessment: "Prueba",
	StatusInterview:  "Entrevista",
	StatusOffer:      "Oferta",
	StatusRejected:   "Rechazada",
	StatusLapsed:     "Caducado",
	StatusDiscarded:  "Descartada",
	StatusSkip:       "OMITIR",
	StatusHired:      "Contratada",

	// Additional UI strings
	NoData:        "Sin datos",
	EmptyFile:     "(archivo vac├¡o)",
	RateResponse:  "Tasa de respuesta: ",
	RateInterview: "Tasa de entrevistas: ",
	RateOffer:     "Tasa de ofertas: ",

	// Footer descriptions & hints
	HelpNav:        " navegar  ",
	HelpTabs:       " pesta├▒as  ",
	HelpSearch:     " buscar  ",
	HelpSort:       " ordenar  ",
	HelpRefresh:    " actualizar  ",
	HelpReport:     " informe  ",
	HelpOpenURL:    " abrir URL  ",
	HelpOpenPDF:    " abrir PDF  ",
	HelpRegenPDF:   " regenerar PDF  ",
	HelpChange:     " cambiar  ",
	HelpColumns:    " columnas  ",
	HelpView:       " vista  ",
	HelpProgress:   " progreso  ",
	HelpStats:      " estad├¡sticas  ",
	HelpQuit:       " salir",
	HelpScroll:     " desplazar  ",
	HelpPage:       " p├ígina  ",
	HelpTopEnd:     " inicio/fin  ",
	HelpLanguage:   " idioma  ",
	HelpManifesto:  " manifiesto  ",
	HelpBack:       " atr├ís",
	HelpNavigate:   " navegar  ",
	HelpToggle:     " alternar  ",
	HelpClose:      " cerrar",
	HelpConfirm:    " confirmar  ",
	HelpCancel:     " cancelar",
	HelpFilterLive: " filtrar en vivo  ",
	HelpKeep:       " guardar  ",
	HelpClear:      " limpiar  ",

	// Picker overlay titles & bar hints
	PickerChangeStatus: "Cambiar estado:",
	PickerColumnsTitle: "ΓöÇΓöÇΓöÇ Columnas (SPACE alternar ┬╖ ESC cerrar) ΓöÇΓöÇΓöÇ",
	SearchHintInput:    "   Enter: guardar   Esc: cancelar   Ctrl+U: limpiar",
	SearchHintNormal:   "   Esc: limpiar   /: editar",
	SearchMatching:     "  %d/%d coincidencias",
	SortLabel:          "[Orden: %s]",
	ViewLabel:          "[Vista: %s]",
	ShownCount:         "%d mostradas",
	ColReport:          "INF",
	ColPDF:             "PDF",

	// Sort & view modes
	SortScore:    "puntuaci├│n",
	SortDate:     "fecha",
	SortCompany:  "empresa",
	SortStatus:   "estado",
	SortLocation: "ubicaci├│n",
	SortPay:      "salario",
	SortLast:     "├║ltimo",
	SortPosted:   "publicado",
	ViewGrouped:  "agrupado",
	ViewFlat:     "plano",
}

// Current points to the active language catalog. Defaults to English (&En).
var Current = &En

// languages is the single source of truth for which languages exist, in the
// order ToggleLang cycles them. SetLang, GetLang and ToggleLang all read it, so
// adding a language is one entry here rather than three separate edits that can
// drift ΓÇö which is how ToggleLang came to be unable to reach Spanish.
//
// Order matters twice: it is the cycle order, and SetLang matches by prefix in
// this order. "en" before "es" is harmless since neither is a prefix of the
// other, but a future code that is a prefix of another must come after it.
var languages = []struct {
	code    string
	catalog *Catalog
}{
	{"en", &En},
	{"tr", &Tr},
	{"es", &Es},
}

// SetLang sets the active catalog based on language code prefix
// (e.g., "tr", "tr_TR" -> &Tr; "es", "es_ES" -> &Es; anything else -> &En).
func SetLang(lang string) {
	l := strings.ToLower(strings.TrimSpace(lang))
	for _, entry := range languages {
		if strings.HasPrefix(l, entry.code) {
			Current = entry.catalog
			return
		}
	}
	Current = &En
}

// ToggleLang advances Current to the next language in `languages`, wrapping.
//
// It used to flip between &En and &Tr, with every other catalog falling into
// the else branch and landing on English. Spanish was added after that was
// written, so a user who started the dashboard in Spanish pressed the key the
// help bar advertises as "lang" and could not get back ΓÇö the toggle could only
// ever reach English and Turkish. Cycling makes every supported language
// reachable from every other one.
func ToggleLang() {
	for i, entry := range languages {
		if Current == entry.catalog {
			Current = languages[(i+1)%len(languages)].catalog
			return
		}
	}
	// Current points at a catalog outside the list: land somewhere defined
	// rather than leaving it unchanged, so the key always does something.
	Current = &En
}

// GetLang returns the active language code, or "en" when Current points at a
// catalog that is not in `languages`.
func GetLang() string {
	for _, entry := range languages {
		if Current == entry.catalog {
			return entry.code
		}
	}
	return "en"
}