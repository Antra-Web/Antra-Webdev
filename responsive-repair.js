(function(){
  function init(){
    document.querySelectorAll('.navbar').forEach(function(nav){
      var links=nav.querySelector('.nav-links'); if(!links) return;
      var button=document.createElement('button');
      button.className='mobile-menu-toggle'; button.type='button';
      button.setAttribute('aria-label','Open navigation'); button.setAttribute('aria-expanded','false');
      button.setAttribute('aria-controls','mobile-navigation');
      button.innerHTML='<span aria-hidden="true"></span>';
      links.id='mobile-navigation'; nav.insertBefore(button,links);
      function close(){button.setAttribute('aria-expanded','false');button.setAttribute('aria-label','Open navigation');links.classList.remove('is-open')}
      button.addEventListener('click',function(){var open=button.getAttribute('aria-expanded')==='true'; if(open) close(); else {button.setAttribute('aria-expanded','true');button.setAttribute('aria-label','Close navigation');links.classList.add('is-open')}})
      links.querySelectorAll('a').forEach(function(a){a.addEventListener('click',close)});
      document.addEventListener('keydown',function(e){if(e.key==='Escape') close()});
      document.addEventListener('click',function(e){if(!nav.contains(e.target)) close()});
    });
  }
  if(document.readyState==='loading') document.addEventListener('DOMContentLoaded',init); else init();
})();
