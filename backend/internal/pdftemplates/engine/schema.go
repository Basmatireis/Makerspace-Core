package engine

import (
	"strings"
	"time"
)

// FieldType is the type of a variable as the editor shows it.
type FieldType string

const (
	FieldText     FieldType = "text"
	FieldDate     FieldType = "date"
	FieldMoney    FieldType = "money"
	FieldNumber   FieldType = "number"
	FieldList     FieldType = "list"
	FieldTextList FieldType = "list<text>"
	FieldImage    FieldType = "image"
)

// Permissions some variables need. They are the registered permission ids; the engine only compares strings.
const (
	permissionOrdersRead          = "orders.read"
	permissionPeopleMatriculation = "people.read.matriculation"
)

// Field is one variable of an export.
type Field struct {
	Path        string    `json:"path"`
	Type        FieldType `json:"type"`
	Permission  string    `json:"permission,omitempty"`
	Description string    `json:"description"`
	Example     string    `json:"example,omitempty"`
}

// Group is a group of variables; List names the list a group's fields belong to ("items" for items[].x).
type Group struct {
	Name        string  `json:"name"`
	List        string  `json:"list,omitempty"`
	Description string  `json:"description,omitempty"`
	Fields      []Field `json:"fields"`
}

// FilterInfo describes one filter of the expression language.
type FilterInfo struct {
	Name        string `json:"name"`
	Description string `json:"description"`
}

// SchemaInfo is everything a template of an export may reference.
type SchemaInfo struct {
	Groups  []Group      `json:"groups"`
	Filters []FilterInfo `json:"filters"`
}

type fieldDef struct {
	path       string
	typ        FieldType
	permission string
}

type groupDef struct {
	name   string
	list   string
	fields []fieldDef
}

func f(path string, typ FieldType) fieldDef { return fieldDef{path: path, typ: typ} }

func gated(path string, typ FieldType, permission string) fieldDef {
	return fieldDef{path: path, typ: typ, permission: permission}
}

var schemaGroups = map[Kind][]groupDef{
	KindWiRef: {
		{name: "Request", fields: []fieldDef{
			f("request.number", FieldText), f("request.orderNumber", FieldText), f("request.approvedAt", FieldDate),
			f("request.approver", FieldText), f("request.servicePeriod.from", FieldDate),
			f("request.servicePeriod.to", FieldDate), f("request.serviceDescription", FieldText),
		}},
		{name: "Recipient", fields: []fieldDef{
			f("recipient.organization", FieldText), f("recipient.addressLines", FieldTextList),
			f("recipient.contactName", FieldText), f("recipient.contactChannel", FieldText),
			f("recipient.purchaseOrderReference", FieldText),
		}},
		{name: "Amounts", fields: []fieldDef{
			f("amounts.total", FieldMoney), f("amounts.alreadyPaid", FieldMoney), f("amounts.toInvoice", FieldMoney),
		}},
		{name: "Texts from the wiRef settings", fields: []fieldDef{
			f("texts.title", FieldText), f("texts.intro", FieldText), f("texts.closing", FieldText),
		}},
		{name: "Shown parts from the wiRef settings", fields: []fieldDef{
			f("show.contactPerson", FieldText), f("show.approver", FieldText), f("show.purchaseOrder", FieldText),
			f("show.servicePeriod", FieldText), f("show.serviceDescription", FieldText),
		}},
		{name: "Items (list)", list: "items", fields: []fieldDef{
			f("items[].description", FieldText), f("items[].quantity", FieldNumber), f("items[].unit", FieldText),
			f("items[].unitPrice", FieldMoney), f("items[].amount", FieldMoney),
		}},
		{name: "Payments (list)", list: "payments", fields: paymentFields("payments[]")},
	},
	KindCashbook: {
		{name: "Period", fields: []fieldDef{
			f("period.from", FieldDate), f("period.to", FieldDate), f("period.businessYear", FieldText),
			f("period.contents", FieldText),
			f("period.kind", FieldText),
		}},
		{name: "Organization", fields: []fieldDef{
			f("organization.name", FieldText), f("organization.unit", FieldText),
			f("organization.department", FieldText),
		}},
		{name: "Totals", fields: []fieldDef{
			f("totals.opening", FieldMoney), f("totals.in", FieldMoney), f("totals.out", FieldMoney),
			f("totals.closing", FieldMoney),
		}},
		{name: "Lines (list)", list: "lines", fields: []fieldDef{
			f("lines[].no", FieldNumber), f("lines[].date", FieldDate), f("lines[].cashier", FieldText),
			f("lines[].kind", FieldText), f("lines[].text", FieldText), f("lines[].orderReference", FieldText),
			gated("lines[].orderSummary", FieldText, permissionOrdersRead),
			gated("lines[].customer", FieldText, permissionOrdersRead),
			f("lines[].method", FieldText), f("lines[].receiptNumber", FieldText), f("lines[].in", FieldMoney),
			f("lines[].out", FieldMoney), f("lines[].balance", FieldMoney),
		}},
	},
	KindReceipt: {
		{name: "Order", fields: []fieldDef{
			f("order.number", FieldText), f("order.createdAt", FieldDate), f("order.customer.name", FieldText),
			gated("order.customer.matriculationNumber", FieldText, permissionPeopleMatriculation),
			f("order.total", FieldMoney), f("order.paid", FieldMoney), f("order.open", FieldMoney),
		}},
		{name: "Payment (receipt of one payment)", fields: paymentFields("payment")},
		{name: "Items (list)", list: "items", fields: []fieldDef{
			f("items[].description", FieldText), f("items[].detail", FieldText), f("items[].quantity", FieldNumber),
			f("items[].unit", FieldText), f("items[].unitPrice", FieldMoney), f("items[].amount", FieldMoney),
		}},
		{name: "Payments (list)", list: "payments", fields: paymentFields("payments[]")},
	},
}

func paymentFields(prefix string) []fieldDef {
	return []fieldDef{
		f(prefix+".reference", FieldText), f(prefix+".method", FieldText), f(prefix+".paidAt", FieldDate),
		f(prefix+".amount", FieldMoney),
	}
}

// commonGroup is available in every export.
var commonGroup = groupDef{name: "Always available", fields: []fieldDef{
	f("makerspace.name", FieldText), f("makerspace.displayName", FieldText), f("makerspace.address", FieldText),
	f("makerspace.logo", FieldImage), f("generatedAt", FieldDate), f("page", FieldNumber), f("pages", FieldNumber),
	f("sheet.number", FieldNumber), f("sheet.carry", FieldMoney), f("sheet.sumIn", FieldMoney),
	f("sheet.sumOut", FieldMoney), f("sheet.balance", FieldMoney),
}}

// reservedLocals are first path segments a loop alias may not shadow.
var reservedLocals = map[string]bool{
	"index": true, "page": true, "pages": true, "sheet": true, "makerspace": true, "generatedAt": true,
}

var fieldDocs = map[string]string{
	"request.number":                     "Number of this invoice request",
	"request.orderNumber":                "Number of the order the request belongs to",
	"request.approvedAt":                 "When the request was approved",
	"request.approver":                   "Name of the person who approved the request",
	"request.servicePeriod.from":         "First day of the service period; may be empty",
	"request.servicePeriod.to":           "Last day of the service period; empty when the period is a single day",
	"request.serviceDescription":         "What was done, as entered on the request; may be empty",
	"recipient.organization":             "Organization or person the invoice goes to",
	"recipient.addressLines":             `Postal address, one entry per line; combine with join(", ")`,
	"recipient.contactName":              "Contact person at the recipient; may be empty",
	"recipient.contactChannel":           "E-mail or phone of the contact person",
	"recipient.purchaseOrderReference":   "Recipient's purchase order number; may be empty",
	"amounts.total":                      "Order total of all items",
	"amounts.alreadyPaid":                "Paid in cash or by card before the invoice",
	"amounts.toInvoice":                  "Total minus what was already paid: the invoiced amount",
	"texts.title":                        "PDF title from the wiRef settings, placeholders filled in",
	"texts.intro":                        "PDF introduction from the wiRef settings; paragraphs are separated by a blank line",
	"texts.closing":                      "PDF closing text from the wiRef settings; paragraphs are separated by a blank line",
	"show.contactPerson":                 `"true" when the wiRef settings show the contact person, else empty`,
	"show.approver":                      `"true" when the wiRef settings show the approver, else empty`,
	"show.purchaseOrder":                 `"true" when the wiRef settings show the purchase order reference, else empty`,
	"show.servicePeriod":                 `"true" when the wiRef settings show the service period, else empty`,
	"show.serviceDescription":            `"true" when the wiRef settings show the service description, else empty`,
	"items":                              "All order lines; loop over them with a table or repeat",
	"items[].description":                "Text of the order line",
	"items[].detail":                     "Machine and duration, or the spool for material",
	"items[].quantity":                   "Quantity in the line's unit",
	"items[].unit":                       "Unit such as pc, h or g",
	"items[].unitPrice":                  "Price per unit",
	"items[].amount":                     "Quantity × unit price",
	"payments":                           "All payments of the order",
	"payments[].reference":               "Payment number",
	"payments[].method":                  "Cash, card or wiRef invoice",
	"payments[].paidAt":                  "When the payment was recorded",
	"payments[].amount":                  "Amount of this payment",
	"period.from":                        "First day of the export",
	"period.to":                          "Last day of the export",
	"period.businessYear":                "Business year of the period",
	"period.kind":                        `"cash-register" or "all-payments"; used in the file name`,
	"period.contents":                    `Empty for the cash register; "alle Zahlungen" when the export covers every payment method`,
	"organization.name":                  "Name of the student union",
	"organization.unit":                  "Studienlabor or Referat the cash register belongs to",
	"organization.department":            "Department shown under the name",
	"totals.opening":                     "Cash at the start of the first day; empty when the export covers every payment method",
	"totals.in":                          "All money in during the period",
	"totals.out":                         "All money out during the period",
	"totals.closing":                     "Cash at the end of the last day; empty when the export covers every payment method",
	"lines":                              "All cashbook entries of the period",
	"lines[].no":                         "Running number of the entry in this export",
	"lines[].date":                       "Day of the entry",
	"lines[].cashier":                    "Person who recorded the entry",
	"lines[].kind":                       "Receipt, refund, withdrawal, deposit or correction",
	"lines[].text":                       "Description as on the paper form, without the order summary",
	"lines[].orderReference":             "Order number; empty for withdrawals and deposits",
	"lines[].orderSummary":               "What the order charged, by process and material",
	"lines[].customer":                   "Customer of the order",
	"lines[].method":                     "Payment method",
	"lines[].receiptNumber":              "Payment number printed on the receipt",
	"lines[].in":                         "Money in on this entry; empty when 0 with the amount filter",
	"lines[].out":                        "Money out on this entry",
	"lines[].balance":                    "Cash after this entry",
	"order.number":                       "Order number",
	"order.createdAt":                    "When the order was created",
	"order.customer.name":                "Name of the customer",
	"order.customer.matriculationNumber": "Matriculation number of the customer",
	"order.total":                        "Order total",
	"order.paid":                         "Sum of all payments",
	"order.open":                         "Still to pay",
	"payment.reference":                  "Payment number; only set for the receipt of one payment",
	"payment.method":                     "Method of that payment",
	"payment.paidAt":                     "When that payment was recorded",
	"payment.amount":                     "Amount of that payment",
	"makerspace.name":                    "Organization name from the branding settings",
	"makerspace.displayName":             "Display name of the application from the branding settings",
	"makerspace.address":                 "Address from the branding settings",
	"makerspace.logo":                    "Logo from the branding settings; place it with the Logo element",
	"generatedAt":                        "When the PDF is created",
	"page":                               "Number of the current page (header, footer and layers)",
	"pages":                              "Number of pages of the document",
	"sheet.number":                       "Number of the sheet, inside a form table",
	"sheet.carry":                        "Balance carried over to this sheet",
	"sheet.sumIn":                        "Sum of this sheet's money in",
	"sheet.sumOut":                       "Sum of this sheet's money out",
	"sheet.balance":                      "Balance at the end of this sheet",
}

// filterOrder lists the filters as the editor shows them.
var filterOrder = []FilterInfo{
	{"currency", "EUR amount, e.g. 1.234,50 € (de) or EUR 1,234.50 (en)"},
	{"amount", "number with 2 decimals, without currency; 0 is empty in the cashbook"},
	{"number", "number with n decimals: number(0)"},
	{"date", `date, optional pattern: date("dd.MM.yyyy")`},
	{"datetime", "date and time: 14.11.2026 09:30"},
	{"time", "time only: 09:30"},
	{"upper", "capitals"},
	{"lower", "lower case"},
	{"capitalize", "first letter as a capital"},
	{"default", `fallback when empty: default("—")`},
	{"prefix", `text before the value, only when it is set: prefix(" · ")`},
	{"suffix", `text after the value, only when it is set: suffix(" h")`},
	{"truncate", "cut to n characters with …: truncate(48)"},
	{"join", `join a list: join(", ")`},
	{"count", "number of entries of a list"},
	{"sum", `total of a field over a list: sum("amount")`},
	{"first", "first entry of a list"},
	{"last", "last entry of a list"},
}

// Filters lists every filter of the expression language with its description.
func Filters() []FilterInfo { return append([]FilterInfo(nil), filterOrder...) }

// schemaIndex resolves canonical paths ("items[].amount") of one export.
type schemaIndex struct {
	fields map[string]fieldDef
}

var schemaIndexes = func() map[Kind]*schemaIndex {
	out := map[Kind]*schemaIndex{}
	for kind, groups := range schemaGroups {
		index := &schemaIndex{fields: map[string]fieldDef{}}
		for _, g := range append(append([]groupDef(nil), groups...), commonGroup) {
			if g.list != "" {
				index.fields[g.list] = fieldDef{path: g.list, typ: FieldList}
			}
			for _, field := range g.fields {
				index.fields[field.path] = field
				if field.typ == FieldTextList {
					index.fields[field.path+"[]"] = fieldDef{path: field.path + "[]", typ: FieldText, permission: field.permission}
				}
			}
		}
		out[kind] = index
	}
	return out
}()

func (s *schemaIndex) lookup(canonical string) (fieldDef, bool) {
	field, ok := s.fields[canonical]
	return field, ok
}

// isList says whether a canonical path is something a loop can run over.
func (s *schemaIndex) isList(canonical string) bool {
	field, ok := s.fields[canonical]
	return ok && (field.typ == FieldList || field.typ == FieldTextList)
}

// Schema describes the variables of an export with examples formatted from the sample data.
func Schema(kind Kind) SchemaInfo {
	sample := SampleData(kind)
	builtin := Builtin(kind)
	ex := newEvaluator(evalConfig{
		kind:      kind,
		locale:    builtin.Page.Locale,
		location:  viennaLocation,
		blankZero: false,
		can:       func(string) bool { return true },
	}, sampleRoot(kind, sample))
	info := SchemaInfo{Filters: Filters()}
	for _, g := range append(append([]groupDef(nil), schemaGroups[kind]...), commonGroup) {
		group := Group{Name: g.name, List: g.list, Description: fieldDocs[g.list], Fields: []Field{}}
		for _, field := range g.fields {
			group.Fields = append(group.Fields, Field{
				Path:        field.path,
				Type:        field.typ,
				Permission:  field.permission,
				Description: fieldDocs[field.path],
				Example:     ex.example(field),
			})
		}
		info.Groups = append(info.Groups, group)
	}
	return info
}

// sampleRoot adds the always-available values to sample data, for examples.
func sampleRoot(kind Kind, data Data) Data {
	root := Data{}
	for k, v := range data {
		root[k] = v
	}
	root["makerspace"] = map[string]any{
		"name": sampleBranding.Name, "displayName": sampleBranding.DisplayName, "address": sampleBranding.Address,
	}
	root["generatedAt"] = sampleNow
	root["page"] = 1
	root["pages"] = 2
	root["sheet"] = sampleSheet(kind)
	return root
}

// example formats the sample value of a field the way a template shows it without a filter.
func (e *evaluator) example(field fieldDef) string {
	segments := strings.Split(field.path, ".")
	var value any = e.root
	for _, segment := range segments {
		name, isList := strings.CutSuffix(segment, "[]")
		value = member(value, name)
		if isList {
			value = firstEntry(value)
		}
	}
	switch field.typ {
	case FieldList:
		return ""
	case FieldImage:
		return ""
	case FieldMoney:
		text, _ := e.currency(value)
		return text
	}
	return e.display(value, field.typ)
}

var viennaLocation = func() *time.Location {
	location, err := time.LoadLocation("Europe/Vienna")
	if err != nil {
		return time.FixedZone("Europe/Vienna", 60*60)
	}
	return location
}()
