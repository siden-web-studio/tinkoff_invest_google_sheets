const OPENAPI_TOKEN = SpreadsheetApp.getActiveSpreadsheet().getSheetByName("Настройки").getRange("B1").getValue()
const TRADING_START_AT = new Date('Jan 01, 2019 10:00:00')
const MILLIS_PER_DAY = 1000 * 60 * 60 * 24

function isoToDate(dateStr){
  const str = dateStr.replace(/-/,'/').replace(/-/,'/').replace(/T/,' ').replace(/\+/,' \+').replace(/Z/,' +00')
  return new Date(str)
}
    
function onOpen() {
  var sheet = SpreadsheetApp.getActiveSpreadsheet()
  var entries = [{
    name : "Обновить",
    functionName : "refresh"
  }]
  sheet.addMenu("TI", entries)
};

function refresh() {
  SpreadsheetApp.getActiveSpreadsheet().getRange('Z1').setValue(new Date().toTimeString());
}

class TinkoffClient {
  constructor(token){
    this.token = token
    this.baseUrl = 'https://api-invest.tinkoff.ru/openapi/'
  }
  _makeApiCall(methodUrl){
    const url = this.baseUrl + methodUrl
    Logger.log(`[API Call] ${url}`)
    const params = {'escaping': false, 'headers': {'accept': 'application/json', "Authorization": `Bearer ${this.token}`}}
    const response = UrlFetchApp.fetch(url, params)
    if (response.getResponseCode() == 200)
      return JSON.parse(response.getContentText())
  }
  getFIGIbyTicker(ticker){
    const url = `market/search/by-ticker?ticker=${ticker}`
    const data = this._makeApiCall(url)
    return data.payload.instruments[0].figi
  }
  getInstrumentByFigi(figi){
    const url = `market/search/by-figi?figi=${figi}`
    const data = this._makeApiCall(url)
    return data.payload
  }
  getTickerByFigi(figi){
    const url = `market/search/by-figi?figi=${figi}`
    const data = this._makeApiCall(url)
    return data.payload.ticker
  }
  getOrderbookByFigi(figi){
    const url = `market/orderbook?depth=1&figi=${figi}`
    const data = this._makeApiCall(url)
    return data.payload
  }
  getOperations(from, to, figi){
    // Аргументы `from` и `to` должны быть в ISO 8601 формате
    const url = `operations?from=${from}&to=${to}&figi=${figi}`
    const data = this._makeApiCall(url)
    return data.payload.operations
  }
  getAll (from, to) {
    const url = `operations?from=${from}&to=${to}`
    const data = this._makeApiCall(url)
    return data.payload.operations
  }
  getAllIIS (from, to, IISid) {
    const url = `operations?from=${from}&to=${to}&brokerAccountId=${IISid}`
    const data = this._makeApiCall(url)
    return data.payload.operations
  }
  getPort(){
    const url = `portfolio`
    const data = this._makeApiCall(url)
    return data.payload.positions
  }
  getCur(){
    const url = `portfolio/currencies`
    const data = this._makeApiCall(url)
    return data.payload.currencies
  }
  getIIS(IISid){
    const url = `portfolio?brokerAccountId=${IISid}`
    const data = this._makeApiCall(url)
    return data.payload.positions
  }
  getIISid(){
    const url = `user/accounts`
    const data = this._makeApiCall(url)
    return data.payload.accounts
  }
  usdval(){
    const url = `market/orderbook?figi=BBG0013HGFT4&depth=1`
    const data = this._makeApiCall(url)
    return data.payload.lastPrice
  }
}

const tinkoffClient = new TinkoffClient(OPENAPI_TOKEN)
const CACHE = CacheService.getScriptCache()

function getPrice(ticker, refresh){
  const figi = tinkoffClient.getFIGIbyTicker(ticker)
  var {lastPrice} = tinkoffClient.getOrderbookByFigi(figi)
  return lastPrice
}

function getAllTickers(figi){
  var ticker
  if (!figi){
    ticker = ""
  }else{
    var {ticker} = tinkoffClient.getInstrumentByFigi(figi)
  }
  return ticker
}

function _calculateTrades(trades) {
  let totalSum = 0
  let totalQuantity = 0
  for (let j in trades) {
    const {quantity, price} = trades[j]
    totalQuantity += quantity
    totalSum += quantity * price
  }
  const weigthedPrice = totalSum / totalQuantity
  return [totalQuantity, totalSum, weigthedPrice]
}

function getTrades(ticker, from, to) {
  const figi = tinkoffClient.getFIGIbyTicker(ticker)
  if (!from) {
    from = TRADING_START_AT.toISOString()
  }
  if (!to) {
    const now = new Date()
    to = new Date(now + MILLIS_PER_DAY)
    to = to.toISOString()
  }
  const operations = tinkoffClient.getOperations(from, to, figi)
  const values = []
  var com_val
  for (let i=operations.length-1; i>=0; i--) {
    const {operationType, status, trades, date, currency, figi, commission} = operations[i]
    if (operationType == "BrokerCommission" || status == "Decline")
      continue
    let [totalQuantity, totalSum, weigthedPrice] = _calculateTrades(trades)
    if (commission){
      com_val = commission.value
    }else{
      com_val = "-"
    }
    if (operationType == "Sell") {
      totalQuantity = -totalQuantity
      totalSum = -totalSum
      commission.value = -commission.value
    }
    values.push([isoToDate(date), operationType, totalQuantity, weigthedPrice, currency, com_val])
  }
  return values
}

function getAllTrades(from, to, refresh){
  if (!from){
    from = TRADING_START_AT.toISOString()
  }else{
    from = from.toISOString()
  }
  if (!to){
    to = new Date(new Date() + MILLIS_PER_DAY).toISOString()
  }else{
    to = to.toISOString()
  }
  const operations = tinkoffClient.getAll (from, to)
  const values = []
  var com_val
  values.push(["Дата","Тикер","Тип","Кол-во","Цена за 1","Комиссия","Итого","Валюта"])
  for (let i=operations.length-1; i>=0; i--) {
    const {operationType, status, trades, date, currency, figi, commission, payment} = operations[i]
    if (operationType == "BrokerCommission" || operationType == "PayIn" || operationType == "PayOut" || status == "Decline")
      continue
    // если нужно отобразить комиссию брокера (BrokerCommission), пополнение (PayIn) или вывод (PayOut) средств со счета, удалите ненужный вариант. Например, если Вы хотите видеть отображение вывода средств со счёта, удалите " operationType == "PayIn" ||" из строки выше
    let [totalQuantity, totalSum, weigthedPrice] = _calculateTrades(trades)
    if (commission){
      com_val = -commission.value
    }else{
      com_val = 0
    }
    if (operationType == "Tax" || operationType == "TaxDividend" || operationType == "Dividend"){
      totalQuantity = '-'
      weigthedPrice = '-'
    }
    var ticker
    if (!figi){
      ticker = ""
    } else {
      var ticker = tinkoffClient.getTickerByFigi(figi)
    }
    values.push([isoToDate(date), ticker, operationType, totalQuantity, weigthedPrice, com_val, payment-com_val, currency])
  }
  return values
}

function getID(){
  const users = tinkoffClient.getIISid()
  for (let i=users.length-1; i>=0; i--) {
    const {brokerAccountId, brokerAccountType} = users [i]
    if (brokerAccountType == "TinkoffIis")
      IISid = brokerAccountId
  }
  return IISid
}

function getAllTradesIIS(from,to){
  IISid = getID()
  if (!from){
    from = TRADING_START_AT.toISOString()
  }else{
    from = from.toISOString()
  }
  if (!to){
    to = new Date(new Date() + MILLIS_PER_DAY).toISOString()
  }else{
    to = to.toISOString()
  }
  const operations = tinkoffClient.getAllIIS (from, to, IISid)
  const values = []
  values.push(["Дата","Тикер","Тип","Кол-во","Цена за 1","Итого","Валюта"])
  for (let i=operations.length-1; i>=0; i--) {
    const {operationType, status, trades, date, currency, figi, commission, payment} = operations[i]
    if (operationType == "BrokerCommission" || operationType == "PayIn" || operationType == "PayOut" || status == "Decline")
      continue
    // если нужно отобразить комиссию брокера (BrokerCommission), пополнение (PayIn) или вывод (PayOut) средств со счета, удалите ненужный вариант. Например, если Вы хотите видеть отображение вывода средств со счёта, удалите " operationType == "PayIn" ||" из строки выше
    let [totalQuantity, totalSum, weigthedPrice] = _calculateTrades(trades)
    if (operationType == "Sell") {
      totalQuantity = -totalQuantity
      totalSum = -totalSum
      commission.value = -commission.value
    }
    if (operationType == "Tax" || operationType == "TaxDividend" || operationType == "Dividend"){
      totalQuantity = '-'
      weigthedPrice = '-'
    }
    var ticker
    if (!figi){
      ticker = ""
    } else {
      var ticker = tinkoffClient.getTickerByFigi(figi)
    }
    values.push([isoToDate(date), ticker, operationType, totalQuantity, weigthedPrice, payment, currency])
  }
  return values
}

function getPortfolio(refresh){
  const portfolio = tinkoffClient.getPort()
  const values = []
  values.push(["Тикер", "Название", "Кол-во", "Покупка", "Текущая", "Валюта"])
  for (let i=portfolio.length-1; i>=0; i--) {
    const {ticker, name, balance, averagePositionPrice, expectedYield} = portfolio [i]
    buy_price = averagePositionPrice.value * balance
    values.push([
      ticker, name, balance, buy_price, buy_price + expectedYield.value, averagePositionPrice.currency
    ])
  }
  return values
}

function getCurrencies(refresh){
  const values = []
  const portcur = tinkoffClient.getCur()
  for (let i=portcur.length-1; i>=0; i--) {
    const {currency, balance} = portcur [i]
    values.push([currency,balance])
    }
  return values
}

function getUSDval(refresh){
  return tinkoffClient.usdval()
}

function getIISPort(refresh){
  const users = tinkoffClient.getIISid()
  for (let i=users.length-1; i>=0; i--) {
    const {brokerAccountId, brokerAccountType} = users [i]
    if (brokerAccountType == "TinkoffIis")
      IISid = brokerAccountId
  }
  const portfolio = tinkoffClient.getIIS(IISid)
  const values = []
  values.push(["Тикер", "Название", "Кол-во", "Покупка", "Текущая", "Валюта"])
  for (let i=portfolio.length-1; i>=0; i--) {
    const {ticker, name, balance, averagePositionPrice, expectedYield} = portfolio [i]
    buy_price = averagePositionPrice.value * balance
    values.push([
      ticker, name, balance, buy_price, buy_price + expectedYield.value, averagePositionPrice.currency
    ])
  }
  return values
}
