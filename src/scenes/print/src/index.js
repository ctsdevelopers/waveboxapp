import './index.less'
import PDFDatasource from './PDFDatasource'
import PDFPrintRenderer from './PDFPrintRenderer'
import ProgressUI from './ProgressUI'

const progressUI = new ProgressUI(document.getElementById('progress'))
progressUI.isIndeterminate = true
progressUI.status = 'Downloading...'
progressUI.showCancel = true

window.printPDFEncoded = function (encodedLocalPath) {
  window.printPDF(decodeURIComponent(encodedLocalPath))
}

window.printPDF = function (localPath) {
  Promise.resolve()
    .then(() => PDFDatasource.loadPDF(localPath))
    .then((pdfDocument) => {
      progressUI.percentage = 0
      progressUI.isIndeterminate = false
      progressUI.status = 'Drawing...'
      return Promise.resolve(pdfDocument)
    })
    .then((pdfDocument) => {
      return PDFPrintRenderer.renderForPrint(document.getElementById('print-renderer'), pdfDocument, (p) => {
        progressUI.percentage = p
      })
    })
    .then(() => {
      progressUI.percentage = 0
      progressUI.isIndeterminate = true
      progressUI.status = 'Printing...'
      return new Promise((resolve) => {
        setTimeout(resolve, 500) // Let the DOM catch up
      })
    })
    .then(() => {
      document.title = 'wbaction:print'
    })
    .catch((e) => {
      document.title = 'wbaction:error'
    })
}
