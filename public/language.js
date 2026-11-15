const hindi = {
  'Today': 'आज', 'Schedule': 'दवा का समय', 'Refills': 'दवा का स्टॉक', 'Appointments': 'अपॉइंटमेंट',
  'History': 'इतिहास', 'People & access': 'लोग और पहुँच', 'Care Circle': 'देखभाल समूह',
  'Sign out': 'साइन आउट', 'Sign in': 'साइन इन', 'Patient signup': 'मरीज़ खाता',
  'Care-team signup': 'देखभाल टीम खाता', 'Daily care, together.': 'रोज़ की देखभाल, साथ मिलकर।',
  'Larger text': 'बड़ा टेक्स्ट', 'Read today aloud': 'आज की जानकारी सुनें', 'Stop reading': 'सुनना बंद करें',
  'Enable alarm sound': 'अलार्म चालू करें', 'Alarm sound on': 'अलार्म चालू है', 'Silence alarm': 'अलार्म शांत करें',
  'Next dose': 'अगली खुराक', 'Dose due now': 'अभी खुराक का समय है', 'Mark taken': 'ली गई दर्ज करें',
  'All doses recorded': 'सभी खुराकें दर्ज हैं', 'No upcoming doses today': 'आज कोई और खुराक नहीं है',
  'Taken': 'ली गई', 'Due': 'समय हो गया', 'Unconfirmed': 'पुष्टि बाकी', 'Upcoming': 'आगामी',
  'Next appointment': 'अगला अपॉइंटमेंट', 'No upcoming appointments.': 'कोई आगामी अपॉइंटमेंट नहीं है।',
  'Request an appointment': 'अपॉइंटमेंट का अनुरोध करें', 'Request a change': 'समय बदलने का अनुरोध करें',
  'Review change request': 'समय बदलने का अनुरोध देखें', 'Open appointments': 'अपॉइंटमेंट देखें',
  'Today’s doses': 'आज की खुराकें', 'Care follow-ups': 'देखभाल फ़ॉलो-अप', 'Please check in': 'कृपया संपर्क करें',
  'No follow-ups to show.': 'कोई फ़ॉलो-अप नहीं है।', 'Add a medication in Schedule.': 'दवा का समय टैब में दवा जोड़ें।',
  'Recent doses': 'हाल की खुराकें', 'No dose history yet.': 'अभी खुराक का इतिहास नहीं है।',
  'Seven-day appointment summary': 'अपॉइंटमेंट के लिए सात दिनों की रिपोर्ट', 'Print summary': 'रिपोर्ट प्रिंट करें',
  'Medications': 'दवाएँ', 'Medication name': 'दवा का नाम', 'Amount as prescribed': 'बताई गई मात्रा',
  'Dose time (IST)': 'खुराक का समय (IST)', 'Next seven days': 'अगले सात दिन',
  'Requests and scheduled visits': 'अनुरोध और तय अपॉइंटमेंट', 'Doctor': 'डॉक्टर', 'Choose doctor': 'डॉक्टर चुनें',
  'Appointment title': 'अपॉइंटमेंट का नाम', 'Send request to doctor': 'डॉक्टर को अनुरोध भेजें',
  'Reason for the change': 'समय बदलने का कारण', 'When are you next available? (IST)': 'आप अगली बार कब उपलब्ध हैं? (IST)',
  'Send change request': 'समय बदलने का अनुरोध भेजें', 'Change requested': 'समय बदलने का अनुरोध भेजा गया',
  'Medication photo': 'दवा की फ़ोटो', 'Add or replace photo': 'फ़ोटो जोड़ें या बदलें', 'Remove photo': 'फ़ोटो हटाएँ',
  'No appointments scheduled.': 'कोई अपॉइंटमेंट तय नहीं है।'
};

let language = 'en';
let large = false;
try {
  language = localStorage.getItem('carecircle.language') === 'hi' ? 'hi' : 'en';
  large = localStorage.getItem('carecircle.large-text') === 'true';
} catch { /* Browser preferences can be unavailable. */ }

export const tr = value => language === 'hi' ? hindi[value] || value : value;
export const locale = () => language === 'hi' ? 'hi-IN' : 'en-IN';
export const inHindi = () => language === 'hi';

function apply() {
  document.documentElement.lang = language;
  document.documentElement.toggleAttribute('data-large-text', large);
  for (const element of document.querySelectorAll('[data-i18n]')) {
    const text = tr(element.dataset.i18n);
    if (element.textContent !== text) element.textContent = text;
  }
  const textButton = document.getElementById('large-text');
  textButton.textContent = tr('Larger text');
  textButton.setAttribute('aria-pressed', String(large));
  document.getElementById('language').value = language;
}

export function initPreferences(onLanguageChange) {
  apply();
  document.getElementById('language').addEventListener('change', event => {
    language = event.currentTarget.value === 'hi' ? 'hi' : 'en';
    try { localStorage.setItem('carecircle.language', language); } catch { /* Preferences remain active in this tab. */ }
    apply();
    onLanguageChange();
  });
  document.getElementById('large-text').addEventListener('click', () => {
    large = !large;
    try { localStorage.setItem('carecircle.large-text', String(large)); } catch { /* Preferences remain active in this tab. */ }
    apply();
  });
}
