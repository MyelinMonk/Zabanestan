// Stands in for Google's sign-in library (accounts.google.com/gsi/client) in the tests: renderButton draws
// a button that hands the page an "ID token" for localStorage's mock-user, carrying the hashed nonce.
window.google = { accounts: { id: {
  initialize(o) { this.o = o; },
  renderButton(box, opts) {
    const b = document.createElement('button');
    b.type = 'button'; b.className = 'mock-gsi'; b.textContent = 'Continue with Google';
    b.onclick = () => this.o.callback({ credential: 'mock-id.' + (localStorage.getItem('mock-user') || 'A') + '.' + this.o.nonce, select_by: 'btn' });
    box.append(b);
  },
  prompt() {}, disableAutoSelect() {},
} } };
